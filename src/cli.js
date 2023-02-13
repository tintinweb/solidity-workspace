#!/usr/bin/env node
'use strict';
const { writeFileSync } = require("fs");
/** 
 * @author github.com/tintinweb
 * @license MIT
 * 
 * 
 * */
const path = require("path");

const { Workspace } = require('./index');
let ws = new Workspace();

function toJSON(start) {
    var cache = [];
    let out = JSON.stringify(start, (key, value) => {
        if (typeof value === 'object' && value !== null) {
            // Duplicate reference found, discard key
            if (cache.includes(value)) return;

            // Store value in our collection
            cache.push(value);
        }
        return value;
    });
    cache = null; // Enable garbage collection
    return out;
}

function cmdFlatten(argv) {
    argv.files.forEach(f => {
        if (f.endsWith(".sol") && !f.includes("test") && !f.includes("node_modules")) {
            // add files to virtual workspace
            ws.add(f).catch(e => {
                console.error(`ERROR: failed to parse: ${f} - ${e}`);
            });
        }
    });
    ws.withParserReady(undefined, true).then(() => {
        if (argv.t) {
            ws.find(sourceUnit => sourceUnit.contracts[argv.t]).then(results => {
                results.forEach(r => {
                    let flat = r.flatten();
                    console.log(flat);
                    if (argv.output) {
                        writeFileSync(argv.output, flat);
                    }
                });
            });
        } else {
            argv.files.forEach(f => {
                let sourceUnit = ws.get(path.resolve(f));
                if (!sourceUnit) {
                    console.error(`ERROR: could not find parsed sourceUnit for file ${f}`)
                    return;
                }
                let flat = sourceUnit.flatten()
                console.log(flat);
                if (argv.output) {
                    writeFileSync(argv.output, flat);
                }
            });
        }
    });
}

function cmdInheritance(argv) {
    argv.files.forEach(f => {
        if (f.endsWith(".sol") && !f.includes("test") && !f.includes("node_modules")) {
            // add files to virtual workspace
            ws.add(f).catch(e => {
                console.error(`ERROR: failed to parse: ${f} - ${e}`);
            });
        }
    });
    ws.withParserReady(undefined, true).then(() => {
        if (argv.t) {
            ws.find(sourceUnit => sourceUnit.contracts[argv.t]).then(results => {
                results.forEach(r => {
                    Object.entries(r.contracts).forEach(([name, c]) => {
                        if (name == argv.t) {
                            console.log(`${name}: \n  ↖${c.linearizedDependencies.map(e => `${e}`).join("\n  ↖")}`);
                        }
                    });

                });

            });
        } else {
            argv.files.forEach(f => {
                let wsu = ws.get(path.resolve(f));
                if (!wsu) {
                    return;
                }
                Object.entries(wsu.contracts).forEach(([contractName, contract]) => {
                    console.log(`${contractName}: \n  ↖${contract.linearizedDependencies.map(cobj => cobj.name).join("\n  ↖")}`);
                });
            });
        }
    });
}

function cmdStats(argv) {
    argv.files.forEach(f => {
        if (f.endsWith(".sol") && !f.includes("test") && !f.includes("node_modules")) {
            // add files to virtual workspace
            ws.add(f).catch(e => {
                console.error(`ERROR: failed to parse: ${f} - ${e}`);
            });
        }
    });
    ws.withParserReady(undefined, true).then(() => {
        let allContracts = ws.getAllContracts();

        console.log(`SourceUnits: ${Object.keys(ws.sourceUnits).length}`);
        console.log(`Contracts: ${Object.values(ws.sourceUnits).map(su => Object.keys(su.contracts).length).reduce((a, b) => a + b, 0)}`);
        console.log(`Unique Contract Names (excluding duplicate contract names): ${Object.keys(allContracts).length}`);
    });
}

function cmdParse(argv) {
    argv.files.forEach(f => {
        if (f.endsWith(".sol") && !f.includes("test") && !f.includes("node_modules")) {
            // add files to virtual workspace
            ws.add(f).catch(e => {
                console.error(`ERROR: failed to parse: ${f} - ${e}`);
            });
        }
    });
    ws.withParserReady(undefined, true).then(() => {
        for (let su of Object.values(ws.sourceUnits)) {
            if (argv.json) {
                console.log(toJSON(su.ast));
            } else {
                console.log(su.ast);
            }

        }
    });
}

function cmdFuncSig(argv) {
    if (!argv.oneworkspace) {
        // assume file-by-file import resolving
        const tasks = [];
        for (let f of argv.files) {
            if (f.endsWith(".sol") && !f.includes("test") && !f.includes("node_modules")) {
                // add files to virtual workspace
                let ws = new Workspace(undefined, { parseImports: false });
                ws.add(f).catch(e => {
                    console.error(`ERROR: failed to parse: ${f} - ${e}`);
                });
                tasks.push(ws.withParserReady(undefined, true));
            }
        }
        Promise.allSettled(tasks).then(proms => {
            const errors = [];

            const finishedPromises = proms.flat(1).filter(
                (value) => value.status === 'fulfilled'
            );
            const result = finishedPromises
                .reduce((res, suproms) => {
                    for (const su of suproms.value) {
                        if (!su.value) continue; //skip errors
                        try {
                            const sigdata = su.value.getAllFunctionSignatures();
                            for (const sig of sigdata) {
                                if (sig.hasOwnProperty('err')) {
                                    errors.push(sig);
                                    continue; //skip errors
                                }
                                if (!res.hasOwnProperty(sig.sighash)) {
                                    res[sig.sighash] = new Set([sig.signature]);
                                } else {
                                    res[sig.sighash].add(sig.signature);
                                }
                            }
                        } catch (e) {
                            // unrecoverable parser error (linearization failed, etc)
                            console.error(e);
                        }
                    }
                    return res;
                }, {});
            console.log(result);
            console.log(Object.keys(result).length);
            console.log(Object.values(result).filter(v => v.size > 1));
            console.log(errors);
        });
    } else {
        argv.files.forEach(f => {
            if (f.endsWith(".sol") && !f.includes("test") && !f.includes("node_modules")) {
                // add files to virtual workspace
                ws.add(f).catch(e => {
                    console.error(`ERROR: failed to parse: ${f} - ${e}`);
                });
            }
        });
        ws.withParserReady(undefined, true).then(() => {

            const result = [];

            for (let su of Object.values(ws.sourceUnits)) {
                console.log(su.getAllFunctionSignatures())
            }
            if (argv.json) {
                console.log(toJSON(result));
            } else {
                console.log(result);
            }
        });
    }
}

require('yargs') // eslint-disable-line
    .usage('$0 <cmd> [args]')
    .command('flatten <files..>', 'show file contracts structure.', (yargs) => {
        yargs
            .positional('files', {
                describe: 'files to flatten',
                type: 'string'
            })
            .option('t', {
                alias: 'targetContract',
                type: 'string',
                default: undefined,
            })
            .option('o', {
                alias: 'output',
                type: 'string',
                default: undefined,
            });
    }, (argv) => {
        cmdFlatten(argv);
    })
    .command('dependencies <files..>', 'output a linearized list of smart contract dependencies (linerized inherited parents)', (yargs) => {
        yargs
            .positional('files', {
                describe: 'files to analyze',
                type: 'string'
            })
            .option('t', {
                alias: 'targetContract',
                type: 'string',
                default: undefined,
            });
    }, (argv) => {
        cmdInheritance(argv);
    })
    .command('stats <files..>', 'random parser stats', (yargs) => {
        yargs
            .positional('files', {
                describe: 'files to analyze',
                type: 'string'
            });
    }, (argv) => {
        cmdStats(argv);
    })
    .command('parse <files..>', 'print parsed objects', (yargs) => {
        yargs
            .positional('files', {
                describe: 'files to analyze',
                type: 'string'
            })
            .option('j', {
                alias: 'json',
                type: 'boolean',
                default: false,
            });
    }, (argv) => {
        cmdParse(argv);
    })
    .command('funcsigs <files..>', 'print function signatures', (yargs) => {
        yargs
            .positional('files', {
                describe: 'files to analyze',
                type: 'string'
            })
            .option('j', {
                alias: 'json',
                type: 'boolean',
                default: false,
            })
            .option('x', {
                alias: 'oneworkspace',
                type: 'boolean',
                default: false,
            });
    }, (argv) => {
        cmdFuncSig(argv);
    })
    .help()
    .alias('h', 'help')
    .version()
    .alias('v', 'version')
    .argv;

