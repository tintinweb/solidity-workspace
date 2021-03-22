'use strict';
/** 
 * @author github.com/tintinweb
 * @license MIT
 * 
 * */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { linearize } = require('c3-linearization');
const parser = require('@solidity-parser/parser');

const {parserHelpers} = require("./parserHelpers");
const {ParserError, CacheHit} = require("./exceptions");


function getExpressionIdentifier(node){
    while(node.expression){
        node = node.expression;
        if(node.type == "Identifier"){
            return node;
        }
    }
}

class Workspace {
    constructor(basedirs, options){
        this.basedirs = basedirs || [];
        this.options = options || { parseImports: true, resolveIdentifiers: true}; //parseImports
        this.sourceUnits = {};  // path -> sourceUnit
        this.sourceUnitsCache = {}; // hash -> sourceUnit

        this._runningTasks = [];
    }

    async add(fpath, options){ // options = {skipExisting, content}
        options = options || {};
        let prom =  new Promise(async (resolve, reject) => {
            var sourceUnit;

            fpath = path.resolve(fpath); //always use abspath
            if(options.skipExisting && this.sourceUnits[fpath]){
                return resolve(this.sourceUnits[fpath]);
            }

            try {
                // good path
                sourceUnit = new SourceUnit(this);
                if(options.content){ // take content instead of reading it from file
                    sourceUnit.fromSource(options.content);
                    sourceUnit.filePath = fpath;
                } else {
                    sourceUnit = sourceUnit.fromFile(fpath); //options.imports
                }
                
                this.sourceUnitsCache[sourceUnit.hash] = sourceUnit;

            } catch (e) {
                if (e instanceof parser.ParserError) { 
                    //unable to parse
                    console.error(e);
                    //fallthrough: update SourceUnit object to empty object.
                } else if (e instanceof CacheHit){
                    // duplicate source unit (or dbl parse)
                    // 
                    sourceUnit = e.sourceUnit.clone(); //clone the object, override the path
                    sourceUnit.filePath = fpath;
                } else {
                    throw e;
                }
            }
            this.sourceUnits[fpath] = sourceUnit;

            if(this.options.parseImports){
                await sourceUnit._fsFindImports().forEach(importPath => this.add(importPath, {skipExisting: true}));
            }

            return resolve(sourceUnit);
        });
        this._runningTasks.push(prom);
        return prom;
    }

    withParserReady(){
        return new Promise((resolve, reject) => {
            Promise.all(this._runningTasks).then(values => {
                //wait for all the ".add" jobs to finish
                this._runningTasks = [];
                this.update();
                resolve();
            });
        });
        
    }

    update() {
        this._resolveDependencies();
    }

    /** GETTER */
    get(key) {
        return this.sourceUnits[key];
    }

    async find(criteria){
        return new Promise((resolve, reject) => {
            return resolve(this.findSync(criteria));
        });
    }

    findSync(criteria){
        return Object.values(this.sourceUnits).filter(sourceUnit => criteria(sourceUnit));
    }

    async findContractsByName(name){
        return new Promise((resolve, reject) => {
            return resolve(this.findContractsByNameSync(name));
        });
    }

    findContractsByNameSync(name){
        return this.findSync(su => su.contracts.hasOwnProperty(name)).map(su => su.contracts[name]);
    }

    getAllContracts(asObject) {
        let contracts = Object.values(this.sourceUnits).map(su => Object.values(su.contracts)).flat(1);
        if(asObject){
            return contracts.reduce(function(acc, cur, i) {
                acc[cur.name] = cur;
                return acc;
            }, {});
        }
        return contracts;
    }

    /** internal */

    _resolveDependencies() {
        let allContracts = this.getAllContracts(true);
        let dependencyMap = Object.values(allContracts).reduce((acc, cur) => {
            acc[cur.name] = cur.dependencies;
            return acc;
        }, {});

        Object.entries(linearize(dependencyMap, { reverse: true })).forEach(([contractName, linearizedDeps]) => {
            if(allContracts[contractName]){ //ignore contracts we dont know yet (missing import?)
                allContracts[contractName].linearizedDependencies = linearizedDeps || [];
            }
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
        this.hash = undefined;
    }

    clone(){
        return Object.assign(new SourceUnit(this.workspace), this);
    }

    fromFile(fpath){
        
        if (!fs.existsSync(fpath)) {
            throw Error(`File '${fpath}' does not exist.` );
        }
        this.filePath = path.resolve(fpath);
        console.error(`→ fromFile(): ${this.filePath}`);

        let content = fs.readFileSync(this.filePath).toString('utf-8');
        this.fromSource(content);
        return this;
    }

    fromSource(content){
        this.hash = crypto.createHash('sha1').update(content).digest('hex');
        console.error(`→ fromSource(): hash=${this.hash}`);

        /** cache-lookup first */
        if (this.workspace.sourceUnitsCache[this.hash]) {
            console.error('→ fromSource(): cache hit!');
            throw new CacheHit(this.workspace.sourceUnitsCache[this.hash]);
        }

        /** parser magic */
        this.parseAst(content);

        /** linearize imports */

        /** resolve idents */
        if (this.workspace.options.resolveIdentifiers){
            this._resolveIdentifiers();
        }
    }

    parseAst(input) {
        console.error(" * parseAst()");
        this.ast = parser.parse(input, { loc: true, tolerant: true });

        if (typeof this.ast === "undefined") {
            throw new ParserError("Parser failed to parse file.");
        }

        /** AST rdy */

        var this_sourceUnit = this;

        parser.visit(this.ast, {
            PragmaDirective(node) { this_sourceUnit.pragmas.push(node); },
            ImportDirective(node) { this_sourceUnit.imports.push(node); },
            ContractDefinition(node) {
                this_sourceUnit.contracts[node.name] = new Contract(this_sourceUnit, node);
            },
        });
        /*** also import dependencies? */
        return this;
    }

    /**
     * Experimental flatten: replaces imports with imported files content.
     */
    flatten() {
        function replaceImports(content){
            return content.replace(/\w*(import[^;]+)/ig, "////$1").replace(/(\/\/ SPDX-License-Identifier)/ig,"////$1-FLATTEN-SUPPRESS-WARNING");
        }
        
        let seen = [];

        let filesToMerge = this._fsFindImportsRecursive().reverse().filter( item =>{
            if (seen.includes(item)) {
                return false;
            }
            seen.push(item);
            return true;
        });

        let flattened = filesToMerge.map(fpath => {
            return `
/** 
 *  SourceUnit: ${this.filePath}
*/
            
${replaceImports(fs.readFileSync(fpath).toString('utf-8'))}
`;}).join("\n\n");
        return flattened + `
/** 
 *  SourceUnit: ${this.filePath}
*/

${replaceImports(fs.readFileSync(this.filePath).toString('utf-8'))}
`;

    }

    _fsFindImportsRecursive(){
        let imports = this._fsFindImports();
        imports = imports.concat(imports.map(fspath => this.workspace.get(fspath)._fsFindImportsRecursive()).flat(1));
        return imports;
    }

    _fsFindImports(){
        /** parse imports */
        console.error("  * parseImports()");
        let result = [];
        let sourceUnit = this;
        
        this.imports.forEach(async imp => {

            //basedir

            let relativeNodeModules = function () {
                let basepath = sourceUnit.filePath.split("/contracts/");

                if (basepath.length == 2) { //super dirty
                    basepath = basepath[0];
                    return path.resolve(basepath + "/node_modules/" + imp.path);
                }
            };

            let lastNodeModules = function () {
                let basepath = sourceUnit.filePath.split("/node_modules/");
                if (basepath.length >= 2) { //super dirty
                    basepath = basepath.slice(0, basepath.length - 2).join("/");
                    return path.resolve(basepath + "/node_modules/" + imp.path);
                }
            };

            let firstNodeModules = function () {
                let basepath = sourceUnit.filePath.split("/node_modules/");
                if (basepath.length >= 2) { //super dirty
                    basepath = basepath[0];
                    return path.resolve(basepath + "/node_modules/" + imp.path);
                }
            };

            let candidates = [
                path.resolve(path.dirname(sourceUnit.filePath) + "/./" + imp.path),
                path.resolve(path.dirname(sourceUnit.filePath) + "/node_modules/" + imp.path),
                relativeNodeModules(),
                lastNodeModules(),
                firstNodeModules(),
                //path.resolve(fileWorkspace + "/./" + imp.path),
                //path.resolve(fileWorkspace + "/node_modules/" + imp.path)
            ]
            .concat(sourceUnit.workspace.basedirs.map(b => path.resolve(b + "/./" + imp.path)))
            .concat(sourceUnit.workspace.basedirs.map(b => path.resolve(b + "/node_modules/" + imp.path)));
            
            let importPath = candidates.find(_importPath => _importPath && fs.existsSync(_importPath));
            if (importPath !== undefined) {
                result.push(importPath);
            } else {
                console.error(`[ERR] Import not found: '${imp.path}' referenced in '${sourceUnit.filePath}'`);
            }
        }, this);
        return result;
    }

    _resolveIdentifiers() {
        console.error("  * _resolveIdentifiers()");
        /*** resolve identifier scope */
        for (var contract in this.contracts) {
            for (var func of this.contracts[contract].functions) {
                func.identifiers.forEach(identifier => {
                    identifier.declarations = {
                        local: [],
                        global: typeof this.contracts[contract].stateVars[identifier.name] == "undefined" ? [] : this.contracts[contract].stateVars[identifier.name]
                    };

                    if (typeof this.contracts[contract].stateVars[identifier.name] != "undefined") {
                        this.contracts[contract].stateVars[identifier.name].usedAt.push(identifier);
                        func.accesses_svar = true;  // TODO: also check for inherited svars 
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
        var BreakException = {};

        let result;
        this.imports.forEach(function (imp) {
            if (typeof result != "undefined") {
                return;
            }
            let contract = this._findImportedContract(imp.ast, searchName);
            if (typeof contract != "undefined" && contract.name == searchName) {
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
        for (let f of contract.functions) {
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

    getExternalCalls(){
        return Object.entries(this.contracts).reduce((acc, [key, contract]) => acc[key]=contract.getExternalCalls(), {});
    }
}

class Contract {
    constructor(_parent, node){
        this._parent = _parent;
        this._node = node;
        this.name = node.name;
        this.dependencies =node.baseContracts.map(spec => spec.baseName.namePath);
        this.linearizedDependencies = []; // will be updated in a later step
        this.stateVars = {};  // pure statevars --> see names
        this.enums = {};  // enum declarations
        this.structs = {}; // struct declarations
        this.mappings = {};  // mapping declarations
        this.modifiers = {};  // modifier declarations
        this.functions = [];  // function and method declarations; can be overloaded
        this.constructor = null;  // ...
        this.events = [];  // event declarations; can be overloaded
        this.inherited_names = {};  // all names inherited from other contracts
        this.names ={};   // all names in current contract (methods, events, structs, ...)
        this.usingFor = {}; // using XX for YY

        this._processAst(node);
    }

    _processAst(node){

        var current_function = null;
        let current_contract = this;

        parser.visit(node, {

            StateVariableDeclaration(_node) {
                parser.visit(_node, {
                    VariableDeclaration(__node) {
                        __node.usedAt = [];
                        current_contract.stateVars[__node.name] = __node;
                        current_contract.names[__node.name] = __node;
                    }
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
                current_function = new FunctionDef(current_contract, _node, "modifier");
                current_contract.modifiers[_node.name] = current_function;
                current_contract.names[_node.name] = current_function;
            },
            EventDefinition(_node) {
                current_function = {
                    _node: _node,
                    name: _node.name,
                    arguments: {},  // declarations: quick access to argument list
                    declarations: {},  // all declarations: arguments+returns+body
                };
                current_contract.events.push(current_function);

                current_contract.names[_node.name] = current_function;
                // parse function body to get all function scope params.
                // first get declarations
                parser.visit(_node.parameters, {
                    VariableDeclaration: function (__node) {
                        current_function.arguments[__node.name] = __node;
                        current_function.declarations[__node.name] = __node;
                    }
                });

            },
            FunctionDefinition(_node) {
                let newFunc = new FunctionDef(current_contract, _node);
                current_contract.functions.push(newFunc);
                current_contract.names[_node.name] = newFunc;
            },
        });
    }

    getExternalCalls(){
        return this.functions.reduce((acc, cur) => acc.concat(cur.getExternalCalls()), []);
    }

    _existsUsingForDeclaration(typeName){
        return Object.values(this.usingFor).some(uf => {
            if(!uf.typeName){
                return true; //uf.typeName is null if this is a "usingFor *""
            }
            return uf.typeName.type=="ElementaryTypeName"? uf.typeName.name==typeName : uf.typeName.namePath==typeName;
        })
    }
}

class FunctionDef {
    constructor(parent, _node, _type){
        this.parent = parent;
        this._node = _node;
        this._type = _type || "function";
        this.name = _node.name;
        this.modifiers = {};   // quick access to modifiers
        this.arguments = {};  // declarations: quick access to argument list
        this.returns = {};  // declarations: quick access to return argument list
        this.declarations = {};  // all declarations: arguments+returns+body
        this.identifiers = [];  // all identifiers (use of variables)
        this.complexity = 0;    // we just count nr. of branching statements here
        this.accesses_svar = false; //
        this.calls = [];  // internal and external calls
        this.assemblyFunctions = {};  // list of assembly functions
        
        this._processAst(_node);
    }

    _processAst(_node){
        let current_function = this;
        let current_contract = this.parent;

        parser.visit(_node.modifiers, {
            ModifierInvocation: function (__node) {
                current_function.modifiers[__node.name] = __node;
            }
        });
        // parse function body to get all function scope params.
        // first get declarations
        parser.visit(_node.parameters, {
            VariableDeclaration: function (__node) {
                current_function.arguments[__node.name] = __node;
                current_function.declarations[__node.name] = __node;
            }
        });
        if(current_function._type=="function"){
            parser.visit(_node.returnParameters, {
                VariableDeclaration: function (__node) {
                    current_function.arguments[__node.name] = __node;
                    current_function.declarations[__node.name] = __node;
                }
            });
        }
        
        
        /**** body declarations */
        parser.visit(_node.body, {
            VariableDeclaration(__node) { 
                current_function.declarations[__node.name] = __node;
            },
            /** 
             * subjective complexity - nr. of branching instructions 
             *   https://stackoverflow.com/a/40069656/1729555
            */
            IfStatement(__node) { current_function.complexity += 1; },
            WhileStatement(__node) { current_function.complexity += 1; },
            ForStatement(__node) { current_function.complexity += 1; },
            DoWhileStatement(__node) { current_function.complexity += 1; },
            InlineAssemblyStatement(__node) { current_function.complexity += 3; },
            AssemblyIf(__node) { current_function.complexity += 2; },
            SubAssembly(__node) { current_function.complexity += 2; },
            AssemblyFor(__node) { current_function.complexity += 2; },
            AssemblyCase(__node) { current_function.complexity += 1; },
            Conditional(__node) { current_function.complexity += 1; },
            AssemblyCall(__node) { current_function.complexity += 1; },
            FunctionCall(__node) {
                current_function.complexity += 2;

                var current_funccall = {
                    name: null,
                    //contract_name: current_contract,
                    type: null,
                    callType: null,
                    declaration: null,
                    _node: __node,
                };

                current_function.calls.push(current_funccall);
                const expr = __node.expression;

                if (parserHelpers.isRegularFunctionCall(__node)) {
                    current_funccall.name = expr.name;
                    current_funccall.type = "regular";

                    //not external

                } else if (parserHelpers.isMemberAccess(__node)) {
                    current_funccall.name = expr.memberName;
                    current_funccall.type = "memberAccess";

                    if (expr.expression.hasOwnProperty('name')) {
                        // variable.send() - check if variable is of userdefinedtype or address, or array of address

                        //1) could be a local declaration (or statevar)
                        let declaration = current_function._findScopedDeclaration(expr.expression.name);
                        if(declaration && (parserHelpers.isAddressDeclaration(declaration) ||parserHelpers.isUserDefinedDeclaration(declaration))){
                            //statevar.send()
                            if(!current_contract._existsUsingForDeclaration(declaration.typeName.namePath)){
                                // if this is a usingFor declartion, skip it.
                                current_funccall.type = "memberAccessOfVar";
                                current_funccall.callType="external";
                                current_funccall.declaration = declaration;
                            }
                            let x; //@todo: existsUsingForDeclaration needs to find actual lib that implements it.
                            

                            //@todo - this can still be an internal call. check if target function is internal. do nothing in this case.
                            //@todo - if target is a library. do nothing
                        }
                        //2) could be a contract type

                        // checking if it is a member of `address` and pass along it's contents
                    } else if (parserHelpers.isMemberAccessOfAddress(__node)) {
                        // address(addr).send()
                        current_funccall.type = "memberAccessOfAddress";
                        current_funccall.callType = "external";

                        // checking if it is a typecasting to a user-defined contract type
                    } else if (parserHelpers.isAContractTypecast(__node)) {
                        // Test(address).send(2);

                        let ident = getExpressionIdentifier(__node);

                        let target_contracts = current_contract._parent.contracts[ident.name];
                        if(target_contracts){
                            target_contracts = [target_contracts];
                        } else {
                            target_contracts = current_contract._parent.workspace.findSync(su => su.contracts[ident.name] && su.contracts[ident.name]._node.kind!="library" ).map(su => su.contracts[ident.name]); //ignore libs
                        }
                        
                        if(target_contracts && target_contracts.some(m => m.functions.find(f => f.name !=__node.expression.memberName || (f.name !=__node.expression.memberName && ["public","external"].includes(f._node.visibility))))){
                            // its a contract, but method is not defined OR method is defined and public/external
                            current_funccall.type = "contractTypecast";
                            current_funccall.callType = "external";
                        }
    

                    } else if (parserHelpers.isMemberAccessOfArrayOrMapping(__node)){
                        //address[] addresses;  addresses[i].send();
                        //check type of array
                        let declaration;
                        let base = __node.expression.expression.base;
                        if(base && base.type=="Identifier"){
                            declaration = current_function._findScopedDeclaration(base.name);
                        }
                        
                        if(declaration) {
                            if(parserHelpers.isAddressArrayDeclaration(declaration) || parserHelpers.isUserDefinedArrayDeclaration(declaration)){
                                //statevar.send()
                                current_funccall.type = "memberAccessOfArrayVar";
                                current_funccall.callType="external";
                                current_funccall.declaration = declaration;
                            }
                            else if (parserHelpers.isAddressMappingDeclaration(declaration) || parserHelpers.isUserDefinedMappingDeclaration(declaration)) {
                                current_funccall.type = "memberAccessOfMappingVarValue";
                                current_funccall.callType="external";
                                current_funccall.declaration = declaration;
                            }
                        } 
                    } else if(parserHelpers.isMemberAccessOfStruct(__node)){
                        //struct[1].item.send(2)
                        console.warn("Struct member external call detection not yet implemented");
                        //need to recurse to find the "Identifier", fetch the declaration, resolve the type and check if Address or UserDefined.

                    } else {
                        //
                        current_funccall.debug = __node.expression;
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
                if(current_funccall.callType==null){
                    //console.log(current_funccall);
                }
            },
            AssemblyFunctionDefinition(__node) {
                current_function.assemblyFunctions[__node.name] = __node;
            }
            // ignore throw, require, etc. for now
        });
        /**** all identifier */
        /**** body declarations */
        parser.visit(_node, {
            //resolve scope
            // check if defined in 
            //
            //
            Identifier(__node) {
                if (!current_function) {
                    return;
                }
                __node.inFunction = current_function;
                __node.scope = undefined;
                __node.scopeRef = undefined;
                current_function.identifiers.push(__node);
            },
            AssemblyCall(__node) {
                if (!current_function) {
                    return;
                }
                __node.inFunction = current_function;
                current_function.identifiers.push(__node);
            }
        });
    }

    _findScopedDeclaration(name){
        //check if name is in local functions scope (declaration), arguments, returns, or statevar
        if(this.declarations[name]){
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
        if(this.parent.stateVars[name]){
            return this.parent.stateVars[name];
        }

        /* // included in svar
        if(this.parent.mappings[name]){
            return this.parent.mappings[name];
        }
        */

        return undefined;
    }

    getExternalCalls(){
        return this.calls.filter(c => c.callType=="external");
    }
}

module.exports = {
    Workspace,
    SourceUnit
};