'use strict';
/**
 * @author github.com/tintinweb
 * @license MIT
 *
 * */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const createKeccakHash = require('keccak');
const {
  canonicalizeEvmType,
  getCanonicalizedArgumentFromAstNode,
} = require('../helper/funcSig');

const { linearize } = require('c3-linearization');
const parser = require('@solidity-parser/parser');

const { parserHelpers } = require('./parserHelpers');
const { ParserError, CacheHit } = require('./exceptions');
const { LRU } = require('../helper/lru');
const { withTimeout } = require('../helper/promise');

const PARSER_TIMEOUT = 3000; //bail after 3 secs.

function getExpressionIdentifier(node) {
  while (node.expression) {
    node = node.expression;
    if (node.type == 'Identifier') {
      return node;
    }
  }
}

function isNodeAtLocation(node, loc) {
  return (
    node.loc.start.line == loc.start.line &&
    node.loc.end.line == loc.end.line &&
    node.loc.start.column == loc.start.column &&
    node.loc.end.column == loc.end.column
  );
}

class Workspace {
  constructor(basedirs, options) {
    this.basedirs = basedirs || [];
    this.options = {
      parseImports: true,
      resolveIdentifiers: true,
      resolveInheritance: true,
      ...options,
    };
    this.sourceUnits = {}; // su path -> sourceUnit
    this.sourceUnitNametoSourceUnit = {}; //su filename --> sourceUnit
    this.sourceUnitsCache = new LRU(500); // LRU hash -> sourceUnit.

    this._runningTasks = [];
  }

  async add(fpath, options) {
    // options = {skipExistingPath, content}
    options = options || {};
    fpath = path.resolve(fpath); //always use abspath
    if (!fpath) return;
    let hash = options.content ? SourceUnit.getHash(options.content) : SourceUnit.getFileHash(fpath)
    // check if there's a running task for that source unit already
    let maybeTasks = this._runningTasks.find((t) => t.meta.fpath === fpath && t.meta.hash === hash);
    if (maybeTasks) {
      return maybeTasks.promise; // skip adding another job for this file
    }

    const promise = new Promise(async (resolve, reject) => {
      var sourceUnit;
      let cacheHit;
      let samePath;

      // avoid parsing files multiple times when subparsing imports; normally not used. lib will automatically return cached sourceUnits if available (see CacheHit)
      const inCache = this.sourceUnits[fpath];
      if (options.skipExistingPath && inCache) {
        return resolve(inCache);
      }
      try {
        // good path; "fromSource()" will auto. check. internal cache to avoid parsing the same file multiple times
        sourceUnit = new SourceUnit(this);
        if (options.content) {
          // take content instead of reading it from file
          sourceUnit.fromSource(options.content);
          sourceUnit.filePath = fpath;
        } else {
          sourceUnit = sourceUnit.fromFile(fpath); //options.imports
        }
      } catch (e) {
        if (e instanceof CacheHit) {
          // duplicate source unit (or dbl parse)
          console.log('cache hit');
          cacheHit = true;
          if (fpath && e.sourceUnit.filePath !== fpath) {
            //same source unit hash, but other path
            sourceUnit = e.sourceUnit.clone(); //clone the object, override the path
            sourceUnit.filePath = fpath;
          } else {
            //same hash, same path
            samePath = true;
            sourceUnit = e.sourceUnit;
          }
          /*
                    } else if (e instanceof parser.ParserError) {
                        //unable to parse
                        console.error(e);
                        //fallthrough: update SourceUnit object to empty object.
                    
                    } else if (e instanceof TypeError) {
                        //unable to parse; parser error
                        console.error(e);
                    */
        } else {
          return reject(e);
        }
      }

      this.sourceUnitsCache.set(sourceUnit.hash, sourceUnit); //refresh the key

      this.sourceUnits[fpath] = sourceUnit;
      this.sourceUnitNametoSourceUnit[path.basename(fpath)] = sourceUnit;
    
      if (!cacheHit && this.options.parseImports) {
        //avoid parsing imports for cacheHits
        try {
          await sourceUnit._fsFindImports().forEach((importPath) =>
            this.add(importPath, { skipExistingPath: true, cancellationToken: options.cancellationToken }).catch((e) => {
              console.error(importPath);
              console.error(e);
            })
          ); // avoid race when parsing the same imports
        } catch (e) {
          console.error(e);
        }
      }

      return resolve(sourceUnit);
    });

    this._runningTasks.push({
      meta: {
        fpath: fpath,
        hash: hash 
      },
      promise: withTimeout(PARSER_TIMEOUT, promise, options.cancellationToken),
    }); //break if promise not resolved after 3sec
    return promise;
  }

  //this resolves when all sourceUnits in scope have been parsed, and inherited identifiers from dependencies resolved.
  async withParserReady(currentSourceUnit, resolveAllInheritance) {
    const values = await Promise.allSettled(
      this._runningTasks.map((t) => t.promise)
    );

    const finishedPromises = values.filter(
      (value) => value.status === 'fulfilled'
    );

    this._runningTasks = [];

    this.update(currentSourceUnit, resolveAllInheritance);
    return finishedPromises;
  }

  update(currentSourceUnit, resolveAllInheritance) {
    this._resolveDepsAndPropagateInheritedNames(
      currentSourceUnit,
      resolveAllInheritance
    );
    this._resolveExternalCalls2ndPass();
  }

  /** GETTER */
  get(key) {
    return this.sourceUnits[key];
  }

  async getSourceUnitByPath(path) {
    const su = this.sourceUnits[path];
    if (su) {
      return su;
    } else {
      const runningTask = this._runningTasks.find((t) => t.meta === path);
      if (runningTask) {
        return await runningTask.promise;
      } else {
        throw new Error('no source unit available for this path');
      }
    }
  }

  async find(criteria) {
    return new Promise((resolve, reject) => {
      return resolve(this.findSync(criteria));
    });
  }

  findSync(criteria) {
    return Object.values(this.sourceUnits).filter((sourceUnit) =>
      criteria(sourceUnit)
    );
  }

  async findContractsByName(name) {
    return new Promise((resolve, reject) => {
      return resolve(this.findContractsByNameSync(name));
    });
  }

  findContractsByNameSync(name) {
    return this.findSync((su) => su.contracts.hasOwnProperty(name)).map(
      (su) => su.contracts[name]
    );
  }

  getAllContracts(asObject) {
    let contracts = Object.values(this.sourceUnits)
      .map((su) => Object.values(su.contracts))
      .flat(1);
    if (asObject) {
      return contracts.reduce(function (acc, cur, i) {
        acc[cur.name] = cur;
        return acc;
      }, {});
    }
    return contracts;
  }

  /** internal */

  _updateInheritedNames(contract, subcontract) {
    if (contract.resolvedInheritance === true) {
      console.log(`inheritance for ${contract.name} already resolved`);
      return;
    }

    /*
    console.log(
      `updating inherited names for contract ${contract.name}, subcontract: ${subcontract.name}`
    );
    */

    if (subcontract.name == contract.name) {
      return; //skip self
    }

    if (subcontract._node.kind === 'interface') {
      //only consider structs and enums
      for (let _var in subcontract.structs) {
        contract.inherited_names[_var] = subcontract;
        contract.inherited_structs[_var] = subcontract.structs[_var];
        contract.inherited_enums[_var] = subcontract.enums[_var];
      }
      return; //skip other inherited names from interfaces
    }

    for (let _var in subcontract.stateVars) {
      if (subcontract.stateVars[_var].visibility != 'private') {
        contract.inherited_names[_var] = subcontract;
      }
    }
    for (let _var of subcontract.functions) {
      if (_var._node.visibility != 'private') {
        contract.inherited_names[_var.name] = subcontract;
      }
    }
    for (let _var of subcontract.events) {
      if (_var._node.visibility != 'private') {
        contract.inherited_names[_var.name] = subcontract;
      }
    }
    for (let _var in subcontract.modifiers) {
      if (subcontract.modifiers[_var].visibility != 'private') {
        contract.inherited_names[_var] = subcontract;
      }
    }
    for (let _var in subcontract.enums) {
      if (subcontract.enums[_var].visibility != 'private') {
        contract.inherited_names[_var] = subcontract;
        contract.inherited_enums[_var] = subcontract.enums[_var];
      }
    }
    for (let _var in subcontract.structs) {
      contract.inherited_names[_var] = subcontract;
      contract.inherited_structs[_var] = subcontract.structs[_var];
    }
    for (let _var in subcontract.mappings) {
      if (subcontract.mappings[_var].visibility != 'private') {
        contract.inherited_names[_var] = subcontract;
      }
    }
  }

  //if currentSourceUnit != undefined, only propagate inherited names for the current source unit path (for performances)
  //excepted if resolveAllInheritance is set, then we resolve for all known source units.
  _resolveDepsAndPropagateInheritedNames(
    currentSourceUnit,
    resolveAllInheritance = false
  ) {
    let allContracts = this.getAllContracts(true);
    let dependencyMap = Object.values(allContracts).reduce((acc, cur) => {
      acc[cur.name] = cur.dependencies;
      return acc;
    }, {});

    if (this.options.resolveInheritance) {
      //resolve imported structs and enums for each source unit
      //note: at this point, we only resolve imports for source units defined outside contracts.
      //below, we will resolve imports for vars defined inside contracts.
      this._propagateImportedVars();
    }

    Object.entries(linearize(dependencyMap, { reverse: true })).forEach(
      ([contractName, linearizedDeps]) => {
        const contractObj = allContracts[contractName];
        if (contractObj) {
          //ignore contracts we dont know yet (missing import?)
          const su = contractObj._parent; //sourceUnit
          const resolveInheritance =
            this.options.resolveInheritance &&
            (su.filePath === currentSourceUnit || resolveAllInheritance);
          allContracts[contractName].linearizedDependencies =
            linearizedDeps
              .filter((depName) => depName !== contractName)
              .map((depContractName) => {
                let depContractObj = allContracts[depContractName];
                if (depContractObj) {
                  if (resolveInheritance)
                    //only resolve for the current source unit
                    this._updateInheritedNames(contractObj, depContractObj);
                  return depContractObj;
                }
                return depContractName; //not found
              }) || [];
          contractObj.resolvedInheritance =
            contractObj.resolvedInheritance || resolveInheritance; //only resolve inheritance once
        }
      }
    );
  }

  _propagateImportedVars() {
    //build the import graph
    let importMap = Object.values(this.sourceUnits).reduce((acc, cur) => {
      acc[path.basename(cur.filePath)] = cur.imports.flatMap((imp) =>
        path.basename(imp.path)
      );
      return acc;
    }, {});

    //Do a DFS in the graph to pull the inherited structs from imports.
    //Should not contain cycles (no cyclic imports)
    //For each S.U., DFS guarantees that we resolve imports from childrens before.
    const toVisit = Object.keys(importMap);
    const visited = {};
    let order = [];
    let idx = 1;
    while (toVisit.length > 0) {
      //loop through all source units
      let tmp = toVisit.pop();
      while (visited[tmp]) {
        tmp = toVisit.pop();
      }
      const stack = [tmp];
      while (stack.length > 0) {
        //inner DFS loop
        const cur = stack.pop();
        if (importMap[cur])
          stack.push(...importMap[cur].filter((v) => !visited[v]));
        if (!visited[cur]) {
          //avoid looping if cycles
          visited[cur] = idx;
          idx += 1;
          order.push(cur);
        }
      }
      //pull imports for each source unit
      order.reverse().forEach((suName) => {
        const su = this.sourceUnitNametoSourceUnit[suName];
        if (su) {
          importMap[suName].forEach((imp) => {
            const impSu = this.sourceUnitNametoSourceUnit[imp];
            if (impSu) {
              Object.assign(su.structs, impSu.structs);
              Object.assign(su.enums, impSu.enums);
            }
          });
        }
      });
      order = [];
    }
  }

  _resolveExternalCalls2ndPass() {
    Object.values(this.sourceUnits).forEach((su) => {
      Object.values(
        su.getExternalCalls(
          (c) => c.callType === 'external' || c.callType === 'inconclusive'
        )
      ).forEach((c) => {
        switch (c.type) {
          case 'memberAccessOfVar':
            // 2nd pass check if the typename target turns out to be a library call. in that case, remove it from external call list
            if (
              !c.declaration ||
              !c.declaration.typeName ||
              !c.declaration.typeName.namePath
            ) {
              return; // skip broken
            }

            let functionImplementationFound = false;

            let fcandidates = [
              c.declaration.typeName.namePath, //complete typename
              c.declaration.typeName.namePath.split('.', 1)[0], //typename split
            ];

            if (c._helper && c._helper.contract) {
              //add usingFor refs if we know them
              fcandidates = fcandidates.concat(
                ...c._helper.contract
                  ._existsUsingForDeclaration(c.declaration.typeName.namePath)
                  .map((uf) => uf.libraryName)
              );
            }

            for (let typename of new Set(fcandidates)) {
              //check if typename is a LIBRARY contract known to the system;
              let found = this.findSync(
                (su) =>
                  su.contracts.hasOwnProperty(typename) &&
                  su.contracts[typename]._node.kind == 'library'
              );
              if (found.length) {
                // we have found a LIBRARY contract.
                // check if the contract exports our function. --> likely, not an extcall ELSE extcall
                functionImplementationFound = !!(
                  found[0][typename] &&
                  found[0][typename].name &&
                  found[0][typename].names[c.name]
                );
                if (functionImplementationFound) {
                  break;
                }
              }
            }

            if (!functionImplementationFound) {
              //assume external call
              c.type = 'memberAccessOfVar';
              c.callType = 'external';
            } else {
              c.type = undefined;
              c.callType = undefined;
            }

            if (c._helper) {
              c._helper = undefined;
            }

            break;
          case 'memberAccessOfUnknownIdentifier':
            if (c.declaration) {
              break; //skip, already resolved
            }
            // check if we finally know if this call points to a library call or not.
            // c._helper contains the contract object. let's find the corresponding contracts
            if (!c._helper) {
              break;
            }
            let deps = c._helper.contract.linearizedDependencies;
            const targetVarName = c._node.expression.expression.name;
            let declaration = deps.find(
              (depContract) =>
                typeof depContract === 'object' &&
                depContract.stateVars[targetVarName]
            );
            if (declaration) {
              c.declaration = declaration.stateVars[targetVarName];
              c.callType = 'external'; //update to external call
              c.type = 'memberAccessOfUnknownIdentifierResolvedToInheritedSVar';
            }
            c._helper = undefined;
            break;
        }
      });
    });
  }
}

class SourceUnit {
  constructor(workspace) {
    this.workspace = workspace;
    this.filePath = undefined;
    this.ast = undefined;
    this.contracts = {};
    this.pragmas = [];
    this.imports = [];
    this.structs = {}; //structs defined outside contract scope
    this.enums = {}; //enums defined outside contract scope
    this.hash = undefined;
  }

  toJSON() {
    return this.ast;
  }

  clone() {
    return Object.assign(new SourceUnit(this.workspace), this);
  }

  fromFile(fpath) {
    const { filePath, content } = SourceUnit.getFileContent(fpath); // returns {fpath, content}
    this.filePath = filePath;
    console.log(`→ fromFile(): ${this.filePath}`);
    this.fromSource(content);
    return this;
  }

  fromSource(content) {
    this.hash = SourceUnit.getHash(content);
    console.log(`→ fromSource(): hash=${this.hash}`);
    /** cache-lookup first */
    let cached = this.workspace.sourceUnitsCache.get(this.hash);
    if (cached) {
      console.log(`→ fromSource(): cache hit! (${cached.filePath})`);
      throw new CacheHit(cached);
    }

    /** parser magic */
    this.parseAst(content);

    /** linearize imports */

    /** resolve idents */
    if (this.workspace.options.resolveIdentifiers) {
      this._resolveIdentifiers();
    }
  }

  parseAst(input) {
    console.log(' * parseAst()');
    this.ast = parser.parse(input, { loc: true, tolerant: true });

    if (typeof this.ast === 'undefined') {
      throw new ParserError('Parser failed to parse file.');
    }

    /** AST rdy */

    var this_sourceUnit = this;

    parser.visit(this.ast, {
      PragmaDirective(node) {
        this_sourceUnit.pragmas.push(node);
      },
      ImportDirective(node) {
        this_sourceUnit.imports.push(node);
      },
      StructDefinition(node, _parent) {
        if (_parent.type === 'SourceUnit')
          this_sourceUnit.structs[node.name] = node;
      },
      EnumDefinition(node, _parent) {
        this_sourceUnit.enums[node.name] = node;
      },
      ContractDefinition(node) {
        this_sourceUnit.contracts[node.name] = new Contract(
          this_sourceUnit,
          node
        );
      },
    });
    /*** also import dependencies? */
    return this;
  }

  /**
   * Experimental flatten: replaces imports with imported files content.
   */
  flatten() {
    function replaceImports(content) {
      return content
        .replace(/\w*(import[^;]+)/gi, '////$1')
        .replace(
          /(\/\/ SPDX-License-Identifier)/gi,
          '////$1-FLATTEN-SUPPRESS-WARNING'
        );
    }

    let seen = [];

    let filesToMerge = this._fsFindImportsRecursive()
      .reverse()
      .filter((item) => {
        if (seen.includes(item)) {
          return false;
        }
        seen.push(item);
        return true;
      });

    let flattened = filesToMerge
      .map((fpath) => {
        return `
/** 
 *  SourceUnit: ${this.filePath}
*/
            
${replaceImports(fs.readFileSync(fpath).toString('utf-8'))}
`;
      })
      .join('\n\n');
    return (
      flattened +
      `
/** 
 *  SourceUnit: ${this.filePath}
*/

${replaceImports(fs.readFileSync(this.filePath).toString('utf-8'))}
`
    );
  }

  static getFileContent(fpath) {
    if (!fs.existsSync(fpath)) {
      throw Error(`File '${fpath}' does not exist.`);
    }
    const filePath = path.resolve(fpath);
    const content = fs.readFileSync(filePath).toString('utf-8');
    return { filePath, content };
  }

  // mainly used to get the filehash while "half-preparing" the source-unit object
  static getFileHash(fpath) {
    const { _, content } = SourceUnit.getFileContent(fpath);
    return SourceUnit.getHash(content);
  }

  static getHash(content) {
    return crypto.createHash('sha1').update(content).digest('hex');
  }

  _fsFindImportsRecursive() {
    let imports = this._fsFindImports();
    imports = imports.concat(
      imports
        .map((fspath) => this.workspace.get(fspath)._fsFindImportsRecursive())
        .flat(1)
    );
    return imports;
  }

  _fsFindImports() {
    /** parse imports */
    console.log('  * parseImports()');
    let result = [];
    let sourceUnit = this;

    this.imports.forEach(async (imp) => {
      //basedir

      let relativeNodeModules = function () {
        let basepath = sourceUnit.filePath.split('/contracts/');

        if (basepath.length == 2) {
          //super dirty
          basepath = basepath[0];
          return path.resolve(basepath + '/node_modules/' + imp.path);
        }
      };

      let lastNodeModules = function () {
        let basepath = sourceUnit.filePath.split('/node_modules/');
        if (basepath.length >= 2) {
          //super dirty
          basepath = basepath.slice(0, basepath.length - 2).join('/');
          return path.resolve(basepath + '/node_modules/' + imp.path);
        }
      };

      let firstNodeModules = function () {
        let basepath = sourceUnit.filePath.split('/node_modules/');
        if (basepath.length >= 2) {
          //super dirty
          basepath = basepath[0];
          return path.resolve(basepath + '/node_modules/' + imp.path);
        }
      };

      let candidates = [
        path.resolve(path.dirname(sourceUnit.filePath) + '/./' + imp.path),
        path.resolve(
          path.dirname(sourceUnit.filePath) + '/node_modules/' + imp.path
        ),
        relativeNodeModules(),
        lastNodeModules(),
        firstNodeModules(),
        //path.resolve(fileWorkspace + "/./" + imp.path),
        //path.resolve(fileWorkspace + "/node_modules/" + imp.path)
      ]
        .concat(
          sourceUnit.workspace.basedirs.map((b) =>
            path.resolve(b + '/./' + imp.path)
          )
        )
        .concat(
          sourceUnit.workspace.basedirs.map((b) =>
            path.resolve(b + '/node_modules/' + imp.path)
          )
        );

      let importPath = candidates.find(
        (_importPath) => _importPath && fs.existsSync(_importPath)
      );
      if (importPath !== undefined) {
        result.push(importPath);
      } else {
        console.error(
          `[ERR] Import not found: '${imp.path}' referenced in '${sourceUnit.filePath}'`
        );
      }
    }, this);

    return result;
  }

  _resolveIdentifiers() {
    console.log('  * _resolveIdentifiers()');
    /*** resolve identifier scope */
    for (var contract in this.contracts) {
      for (var func of Object.values(this.contracts[contract].functions).concat(
        Object.values(this.contracts[contract].modifiers)
      )) {
        func.identifiers.forEach((identifier) => {
          identifier.declarations = {
            local: [],
            global: this.contracts[contract].stateVars.hasOwnProperty(
              identifier.name
            )
              ? []
              : this.contracts[contract].stateVars[identifier.name],
          };

          if (
            this.contracts[contract].stateVars.hasOwnProperty(identifier.name)
          ) {
            this.contracts[contract].stateVars[
              identifier.name
            ].extra.usedAt.push(identifier);
            func.accesses_svar = true; // TODO: also check for inherited svars
          }

          for (let identDec in func.arguments) {
            if (identifier.name == identDec) {
              identifier.declarations.local.push(func.arguments[identDec]);
            }
          }
          for (let identDec in func.returns) {
            if (identifier == identDec) {
              identifier.declarations.local.push(func.returns[identDec]);
            }
          }
        });
      }
    }
  }

  _findImportedContract(searchName) {
    for (var contractName in this.contracts) {
      if (this.contracts[contractName].name == searchName) {
        return this.contracts[contractName];
      }
    }
    //check imports
    let result;
    this.imports.forEach(function (imp) {
      if (typeof result != 'undefined') {
        return;
      }
      let contract = this._findImportedContract(imp.ast, searchName);
      if (typeof contract != 'undefined' && contract.name == searchName) {
        result = contract;
      }
    });
    return result;
  }

  getContractAtLocation(line, column) {
    for (let c of Object.keys(this.contracts)) {
      let loc = this.contracts[c]._node.loc;
      if (line < loc.start.line) {
        continue;
      } else if (line == loc.start.line && column < loc.start.column) {
        continue;
      } else if (line == loc.end.line && column > loc.end.column) {
        continue;
      } else if (line > loc.end.line) {
        continue;
      }

      return this.contracts[c];
    }
  }

  getFunctionAtLocation(line, column) {
    let contract = this.getContractAtLocation(line, column);
    if (!contract) {
      return;
    }
    for (let f of [
      ...contract.functions,
      ...Object.values(contract.modifiers),
    ]) {
      let loc = f._node.loc;
      if (line < loc.start.line) {
        continue;
      } else if (line == loc.start.line && column < loc.start.column) {
        continue;
      } else if (line == loc.end.line && column > loc.end.column) {
        continue;
      } else if (line > loc.end.line) {
        continue;
      }

      return { contract, function: f };
    }
    return { contract };
  }

  getExternalCalls(criteria) {
    return Object.values(this.contracts).reduce(
      (acc, contract) =>
        (acc = acc.concat(contract.getExternalCalls(criteria))),
      []
    );
  }

  getAllContractStructs() {
    return Object.values(this.contracts).reduce(
      (acc, contract) => (acc = acc.concat(contract.structs)),
      []
    );
  }

  getAllFunctionSignatures() {
    return Object.values(this.contracts)
      .map((contract) => contract.getFunctionSignatures())
      .flat(1);
  }
}

class Contract {
  constructor(_parent, node) {
    this._parent = _parent;
    this._node = node;
    this.name = node.name;
    this.dependencies = node.baseContracts.map(
      (spec) => spec.baseName.namePath
    );
    this.linearizedDependencies = []; // will be updated in a later step
    this.stateVars = {}; // pure statevars --> see names
    this.enums = {}; // enum declarations
    this.structs = {}; // struct declarations
    this.mappings = {}; // mapping declarations
    this.modifiers = {}; // modifier declarations
    this.functions = []; // function and method declarations; can be overloaded
    this.nFunction = 0; //incremental count of functions/modifiers declared in this contract
    this.constructor = null; // ...
    this.events = []; // event declarations; can be overloaded
    this.inherited_names = {}; // all names inherited from other contracts
    this.inherited_structs = { ..._parent.structs }; // structs inherited from source unit.
    this.inherited_enums = { ..._parent.enums }; //enums inherited from source unit.
    this.resolvedInheritance = false; //optimization: indicates if we already resolved inherited identifiers
    this.names = {}; // all names in current contract (methods, events, structs, ...)
    this.usingFor = {}; // using XX for YY

    this._processAst(node);
  }

  toJSON() {
    return this._node;
  }

  _processAst(node) {
    var current_function = null;
    let current_contract = this;

    parser.visit(node, {
      StateVariableDeclaration(_node) {
        parser.visit(_node, {
          VariableDeclaration(__node) {
            __node.extra = { usedAt: [] };
            current_contract.stateVars[__node.name] = __node;
            current_contract.names[__node.name] = __node;
          },
        });
      },
      // --> is a subtype. Mapping(_node){current_contract.mappings[_node.name]=_node},
      Mapping(_node) {
        current_contract.mappings[_node.name] = _node;
      },
      EnumDefinition(_node) {
        current_contract.enums[_node.name] = _node;
        current_contract.names[_node.name] = _node;
      },
      StructDefinition(_node) {
        current_contract.structs[_node.name] = _node;
        current_contract.names[_node.name] = _node;
      },
      UsingForDeclaration(_node) {
        current_contract.usingFor[_node.libraryName] = _node;
      },
      ConstructorDefinition(_node) {
        current_contract.constructor = _node;
        current_contract.names[_node.name] = _node;
      }, // wrong def in code: https://github.com/solidityj/solidity-antlr4/blob/fbe865f8ba510cbdb1540fcf9517a42820a4d097/Solidity.g4#L78 for consttuctzor () ..
      ModifierDefinition(_node) {
        current_function = new FunctionDef(
          current_contract,
          _node,
          'modifier',
          current_contract.nFunction++
        );
        current_contract.modifiers[_node.name] = current_function;
        current_contract.names[_node.name] = current_function;
      },
      EventDefinition(_node) {
        current_function = {
          _node: _node,
          name: _node.name,
          arguments: {}, // declarations: quick access to argument list
          declarations: {}, // all declarations: arguments+returns+body
        };
        current_contract.events.push(current_function);

        current_contract.names[_node.name] = current_function;
        // parse function body to get all function scope params.
        // first get declarations
        parser.visit(_node.parameters, {
          VariableDeclaration: function (__node) {
            current_function.arguments[__node.name] = __node;
            current_function.declarations[__node.name] = __node;
          },
        });
      },
      FunctionDefinition(_node) {
        let newFunc = new FunctionDef(
          current_contract,
          _node,
          'function',
          current_contract.nFunction++
        );
        current_contract.functions.push(newFunc);
        current_contract.names[_node.name] = newFunc;
      },
    });
  }

  getExternalCalls(criteria) {
    // functions and modifiers
    return [
      ...this.functions.reduce(
        (acc, cur) => acc.concat(cur.getExternalCalls(criteria)),
        []
      ),
      ...Object.values(this.modifiers).reduce(
        (acc, cur) => acc.concat(cur.getExternalCalls(criteria)),
        []
      ),
    ];
  }

  _existsUsingForDeclaration(typeName) {
    return Object.values(this.usingFor).filter((uf) => {
      if (!uf.typeName) {
        return true; //uf.typeName is null if this is a "usingFor *""
      }
      return uf.typeName.type == 'ElementaryTypeName'
        ? uf.typeName.name == typeName
        : uf.typeName.namePath == typeName;
    });
  }

  getFunctionSignatures() {
    const results = [];
    for (let func of Object.values(this.functions)) {
      // only non constructor/fallback non-internal functions
      if (!func.name || ['private', 'internal'].includes(func.visibility))
        continue;

      try {
        const currSig = {
          contract: this.name,
          ...func.getFunctionSignature(),
        };
        results.push(currSig);
      } catch (e) {
        // likely a Mapping in a public function of a library. skip it.
        // likely Struct lookup failed somehow
        results.push({
          contract: this.name,
          name: func.name,
          err: e.message,
        });
      }
    }
    return results;
  }
}

class FunctionDef {
  constructor(parent, _node, _type, id) {
    this.id = id; //used to identify overriden functions without relying on its signature (avoids the need to resolve argument identifiers). We use an incremental id for every contract function declaration.
    this.parent = parent;
    this._node = _node;
    this._type = _type || 'function';
    this.name = _node.name;
    this.visibility = _node?.visibility; //visibility
    this.modifiers = {}; // quick access to modifiers
    this.arguments = {}; // declarations: quick access to argument list
    this.returns = {}; // declarations: quick access to return argument list
    this.declarations = {}; // all declarations: arguments+returns+body
    this.identifiers = []; // all identifiers (use of variables)
    this.complexity = 0; // we just count nr. of branching statements here
    this.accesses_svar = false; //
    this.calls = []; // internal and external calls
    this.assemblyFunctions = {}; // list of assembly functions

    this._processAst(_node);
  }

  toJSON() {
    return this._node;
  }

  _processAst(_node) {
    let current_function = this;
    let current_contract = this.parent;

    // parse function body to get all function scope params.
    // first get declarations
    parser.visit(_node.parameters, {
      VariableDeclaration: function (__node) {
        current_function.arguments[__node.name] = __node;
        current_function.declarations[__node.name] = __node;
      },
    });
    if (current_function._type == 'function') {
      parser.visit(_node.returnParameters, {
        VariableDeclaration: function (__node) {
          current_function.returns[__node.name] = __node;
          current_function.declarations[__node.name] = __node;
        },
      });
    }

    /**** body declarations */
    parser.visit(_node, {
      VariableDeclaration(__node) {
        current_function.declarations[__node.name] = __node;
      },
      /**
       * subjective complexity - nr. of branching instructions
       *   https://stackoverflow.com/a/40069656/1729555
       */
      IfStatement(__node) {
        current_function.complexity += 1;
      },
      WhileStatement(__node) {
        current_function.complexity += 1;
      },
      ForStatement(__node) {
        current_function.complexity += 1;
      },
      DoWhileStatement(__node) {
        current_function.complexity += 1;
      },
      InlineAssemblyStatement(__node) {
        current_function.complexity += 3;
      },
      AssemblyIf(__node) {
        current_function.complexity += 2;
      },
      SubAssembly(__node) {
        current_function.complexity += 2;
      },
      AssemblyFor(__node) {
        current_function.complexity += 2;
      },
      AssemblyCase(__node) {
        current_function.complexity += 1;
      },
      Conditional(__node) {
        current_function.complexity += 1;
      },
      AssemblyCall(__node) {
        switch (__node.functionName) {
          case 'call':
          case 'delegatecall':
          case 'staticcall':
          case 'callcode':
            current_function.complexity += 2;
            current_function.calls.push({
              //track asm calls
              name: __node.functionName,
              //contract_name: current_contract,
              type: 'AssemblyCall',
              callType: 'external',
              declaration: {
                type: 'Custom',
                typeName: {
                  namePath: 'assembly',
                },
                loc: __node.loc,
              },
              _node: __node,
            });

            break;
          default:
            current_function.complexity += 1;
            break;
        }
      },
      FunctionCall(__node) {
        current_function.complexity += 2;

        var current_funccall = {
          name: null,
          //contract_name: current_contract,
          type: null,
          callType: null,
          declaration: null,
          inFunction: current_function,
          _node: __node,
        };

        current_function.calls.push(current_funccall);
        const expr = __node.expression;

        if (parserHelpers.isRegularFunctionCall(__node)) {
          current_funccall.name = expr.name;
          current_funccall.type = 'regular';

          //not external
        } else if (parserHelpers.isMemberAccessOfNameValueExpression(__node)) {
          // contract.method{value: 1}();  -- is always external
          current_funccall.type = 'NameValueCall';
          current_funccall.callType = 'external';
          current_funccall.name =
            current_funccall.name || __node.expression.expression.memberName;
          current_funccall.declaration = {
            type: 'Identifier',
            typeName: undefined,
            loc: __node.loc,
          };
        } else if (parserHelpers.isMemberAccess(__node)) {
          current_funccall.name = expr.memberName;
          current_funccall.type = 'memberAccess';

          if (expr.expression.hasOwnProperty('name')) {
            // variable.send() - check if variable is of userdefinedtype or address, or array of address

            //1) could be a local declaration (or statevar)
            let declaration = current_function._findScopedDeclaration(
              expr.expression.name
            );
            if (
              declaration &&
              (parserHelpers.isAddressDeclaration(declaration) ||
                parserHelpers.isUserDefinedDeclaration(declaration))
            ) {
              //statevar.send()

              if (declaration.typeName.namePath) {
                let functionImplementationFound = false;

                let fcandidates = [
                  declaration.typeName.namePath, //complete typename
                  declaration.typeName.namePath.split('.', 1)[0], //typename split
                  ...current_contract
                    ._existsUsingForDeclaration(declaration.typeName.namePath)
                    .map((uf) => uf.libraryName), //all usingFors for typename
                ];

                for (let typename of new Set(fcandidates)) {
                  //check if typename is a LIBRARY contract known to the system;
                  let found = current_contract._parent.workspace.findSync(
                    (su) =>
                      su.contracts.hasOwnProperty(typename) &&
                      su.contracts[typename]._node.kind == 'library'
                  );
                  if (found.length) {
                    // but we have found a LIBRARY contract.
                    // check if the contract exports our function. --> likely, not an extcall ELSE extcall
                    functionImplementationFound = !!(
                      found[0][typename] &&
                      found[0][typename].name &&
                      found[0][typename].names[current_funccall.name]
                    );
                    if (functionImplementationFound) {
                      break;
                    }
                  }
                }

                if (!functionImplementationFound) {
                  //assume external call
                  current_funccall.type = 'memberAccessOfVar';
                  current_funccall.callType = 'external'; //likely external. can still be internal but we havent parsed the lib yet.
                  current_funccall.declaration = declaration;
                  current_funccall._helper = { contract: current_contract }; // add a hint abt the current contract for 2nd pass
                } else {
                  current_funccall.type = undefined;
                  current_funccall.callType = undefined; //internal?
                  current_funccall.declaration = declaration;
                }
              }

              //@todo - existsUsingForDeclaration needs to find actual lib that implements it.
              //@todo - this can still be an internal call. check if target function is internal. do nothing in this case.
              //@todo - if target is a library and has a method with this name -> do nothing
            } else if (!declaration) {
              // potentially inherited.function(call)
              const is_library = !!current_contract._parent.workspace.findSync(
                (su) =>
                  su.contracts.hasOwnProperty(expr.expression.name) &&
                  su.contracts[expr.expression.name]._node.kind == 'library'
              ).length;
              if (is_library) {
                // true negative: it is a library call, ignore
              } else {
                // might still be a libcall; need to refine in 2nd pass
                current_funccall.type = 'memberAccessOfUnknownIdentifier';
                current_funccall.callType = 'inconclusive';
                current_funccall.declaration = declaration; //resolve for node.expression.expression.name later
                current_funccall._helper = { contract: current_contract };
              }
            }
            //2) could be a contract type

            // checking if it is a member of `address` and pass along it's contents
          } else if (parserHelpers.isMemberAccessOfAddress(__node)) {
            // address(addr).send()
            current_funccall.type = 'memberAccessOfAddress';
            current_funccall.callType = 'external';
            current_funccall.declaration =
              __node.expression.expression.expression;

            // checking if it is a typecasting to a user-defined contract type
          } else if (parserHelpers.isAContractTypecast(__node)) {
            // Test(address).send(2);

            let ident = getExpressionIdentifier(__node);

            let target_contracts =
              current_contract._parent.contracts[ident.name];
            if (target_contracts) {
              target_contracts = [target_contracts];
            } else {
              target_contracts = current_contract._parent.workspace
                .findSync(
                  (su) =>
                    su.contracts[ident.name] &&
                    su.contracts[ident.name]._node.kind != 'library'
                )
                .map((su) => su.contracts[ident.name]); //ignore libs
            }

            if (
              target_contracts &&
              target_contracts.some((m) =>
                m.functions.find(
                  (f) =>
                    f.name != __node.expression.memberName ||
                    (f.name != __node.expression.memberName &&
                      ['public', 'external'].includes(f._node.visibility))
                )
              )
            ) {
              // its a contract, but method is not defined OR method is defined and public/external
              current_funccall.type = 'contractTypecast';
              current_funccall.callType = 'external';
              current_funccall.declaration =
                __node.expression.expression.expression;
            } else {
              current_funccall.type = 'contractTypecastAnonymous';
              current_funccall.callType = 'external';
              current_funccall.declaration =
                __node.expression.expression.expression;
            }
          } else if (parserHelpers.isMemberAccessOfArrayOrMapping(__node)) {
            //address[] addresses;  addresses[i].send();
            //check type of array
            let declaration;
            let base = __node.expression.expression.base;
            if (base && base.type == 'Identifier') {
              declaration = current_function._findScopedDeclaration(base.name);
            }

            if (declaration) {
              if (
                parserHelpers.isAddressArrayDeclaration(declaration) ||
                parserHelpers.isUserDefinedArrayDeclaration(declaration)
              ) {
                //statevar.send()
                current_funccall.type = 'memberAccessOfArrayVar';
                current_funccall.callType = 'external';
                current_funccall.declaration = declaration;
              } else if (
                parserHelpers.isAddressMappingDeclaration(declaration)
              ) {
                current_funccall.type = 'memberAccessOfAddressMappingVarValue';
                current_funccall.callType = 'external';
                current_funccall.declaration = declaration;
              } else if (
                parserHelpers.isUserDefinedMappingDeclaration(declaration)
              ) {
                // could still be a lib. exclude libs

                //known non library contract?
                let typename = declaration.typeName.valueType.namePath;
                if (typename) {
                  typename = typename.split('.', 1)[0]; //get first typename

                  let knownContract =
                    current_contract._parent.workspace.findSync(
                      (su) =>
                        su.contracts.hasOwnProperty(typename) &&
                        su.contracts[typename]._node.kind != 'library'
                    ); //ignore libs
                  if (knownContract.length) {
                    current_funccall.type =
                      'memberAccessOfUserDefinedMappingVarValue';
                    current_funccall.callType = 'external';
                    current_funccall.declaration = declaration;
                  }
                }
              }
            }
          } else if (parserHelpers.isMemberAccessOfGlobalEvmVar(__node)) {
            current_funccall.type = 'memberAccessOfGlobalEvmVar';
            current_funccall.callType = 'external';
            current_funccall.declaration = {
              type: 'Identifier',
              name: `${__node.expression.expression.expression.name}.${__node.expression.expression.memberName}`,
              typeName: { namePath: 'global' },
              loc: __node.loc,
            };
          } else if (parserHelpers.isMemberAccessOfStruct(__node)) {
            //struct[1].item.send(2)
            console.warn(
              'Struct member external call detection not yet implemented'
            );
            //need to recurse to find the "Identifier", fetch the declaration, resolve the type and check if Address or UserDefined.
          } else {
            //
            //current_funccall.debug = __node.expression;
          }
        } else {
          /** stuff that ends up here is very likely not relevant for us. */
          /** maybe an event? */
          /* skip this check as we dont have a valid case for landing here */
          /*
                    if (current_contract.events.some(e => e.name == __node.expression.name)){
                        return; // emit Event()
                    }
                    */
          /** ignore Contract TypeCast: e.g. Test(address)*/
        }
        if (current_funccall.callType == null) {
          //console.log(current_funccall);
        }
      },
      AssemblyFunctionDefinition(__node) {
        current_function.assemblyFunctions[__node.name] = __node;
      },
      // ignore throw, require, etc. for now
    });

    /**** all identifier */
    /**** body declarations */
    parser.visit(_node.body, {
      //resolve scope
      // check if defined in
      //
      //
      Identifier(__node, parent) {
        if (!current_function) {
          return;
        }
        let ident = __node;
        ident.extra = {
          inFunction: current_function,
          scope: undefined,
          declaration: undefined,
        };
        // find declaration; narrow scope first
        if (current_function.declarations[ident.name]) {
          // local declaration; can be ARGS, RETURNS or BODY
          if (current_function.arguments[ident.name]) {
            if (
              parent.type == 'FunctionCall' &&
              !parent.arguments.some((pa) => isNodeAtLocation(ident, pa.loc))
            ) {
              ident.extra.scope = 'namedArgument';
            } else {
              ident.extra.scope = 'argument';
              ident.extra.declaration = current_function.arguments[ident.name];
            }
          } else if (current_function.returns[ident.name]) {
            ident.extra.scope = 'returns';
            ident.extra.declaration = current_function.returns[ident.name];
          } else {
            ident.extra.scope = 'body';
            ident.extra.declaration = current_function.declarations[ident.name];
          }

          if (ident.extra.declaration) {
            // might be unset for namedArgument (because no declaration)
            if (ident.extra.declaration.storageLocation == 'storage') {
              ident.extra.scope = 'storageRef'; // is a storage reference; may be treated as statevar
            }
          }
        } else if (current_contract.stateVars[ident.name]) {
          // statevar
          ident.extra.scope = 'stateVar';
          ident.extra.declaration = current_contract.stateVars[ident.name];
        } else if (
          current_contract.inherited_names[ident.name] &&
          current_contract.inherited_names[ident.name] != current_contract
        ) {
          // inherited
          // inaccurate first check. needs to be resolved after parsing all files
          ident.extra.scope = 'inheritedName';
          ident.extra.declaration =
            current_contract.inherited_names[ident.name];
        } else {
          // unclear scope, likely inherited
          // normal identifier or inconclusive
        }
        current_function.identifiers.push(__node);
      },
      AssemblyCall(__node) {
        if (!current_function) {
          return;
        }
        __node.extra = {
          inFunction: current_function,
        };
        current_function.identifiers.push(__node);
      },
    });
    parser.visit(_node.modifiers, {
      ModifierInvocation: function (__node) {
        current_function.modifiers[__node.name] = __node;

        //subparse arguments as identifiers
        parser.visit(__node.arguments, {
          Identifier: function (nodeModArgIdent) {
            if (!current_function) {
              return;
            }
            let ident = nodeModArgIdent;
            ident.extra = {
              inFunction: current_function,
              scope: 'super',
              declaration: current_function.arguments[ident.name],
            };
            current_function.identifiers.push(ident);
          },
        });
      },
    });
  }

  _findScopedDeclaration(name) {
    //check if name is in local functions scope (declaration), arguments, returns, or statevar
    if (this.declarations[name]) {
      return this.declarations[name];
    }
    /*
        if(this.arguments[name]){
            return this.arguments[name];
        }
        if(this.returns[name]){
            return this.returns[name];
        }
        */
    if (this.parent.stateVars[name]) {
      return this.parent.stateVars[name];
    }

    /* // included in svar
        if(this.parent.mappings[name]){
            return this.parent.mappings[name];
        }
        */

    return undefined;
  }

  getExternalCalls(criteria) {
    return this.calls.filter((c) =>
      criteria ? criteria(c) : c.callType == 'external'
    );
  }

  getFunctionSignature() {
    //should check if structs in the contract have been resolved first!
    const contract = this.parent;
    if (!contract) {
      throw new Error('Missing contract for the current function');
    }
    if (!contract.resolvedInheritance) {
      //resolve inherited structs before
      throw new Error(
        'Please resolve inheritance for this source unit before computing function signatures.'
      );
    }
    let funcname = this.name;

    // let argsItem =
    //   item.parameters.type === 'ParameterList'
    //     ? item.parameters.parameters
    //     : item.parameters;
    let args = Object.values(this.arguments).map((o) =>
      canonicalizeEvmType(
        getCanonicalizedArgumentFromAstNode(o, this._node, contract)
      )
    );

    let fnsig = `${funcname}(${args.join(',')})`;
    let sighash = createKeccakHash('keccak256')
      .update(fnsig)
      .digest('hex')
      .toString('hex')
      .slice(0, 8);

    return {
      name: funcname,
      signature: fnsig,
      sighash: sighash,
    };
  }
}

module.exports = {
  Workspace,
  SourceUnit,
};
