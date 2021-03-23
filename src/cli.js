'use strict';
/** 
 * @author github.com/tintinweb
 * @license MIT
 * 
 * 
 * */
const path = require("path");

const { Workspace } = require('./index');
let ws = new Workspace();

function cmdFlatten(argv) {
    argv.files.forEach(f => {
        if (f.endsWith(".sol") && !f.includes("test") && !f.includes("node_modules")) {
            // add files to virtual workspace
            ws.add(f);
        }
    });
    ws.withParserReady().then(() => {
        if (argv.t) {
            ws.find(sourceUnit => sourceUnit.contracts[argv.t]).then(results => {
                results.forEach(r => {
                    console.log(r.flatten());
                });
            });
        } else {
            argv.files.forEach(f => {
                console.log(ws.get(path.resolve(f)).flatten());
            });
        }
    });
}

function cmdInheritance(argv) {
    argv.files.forEach(f => {
        if (f.endsWith(".sol") && !f.includes("test") && !f.includes("node_modules")) {
            // add files to virtual workspace
            ws.add(f);
        }
    });
    ws.withParserReady().then(() => {
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
                Object.entries(ws.get(path.resolve(f)).contracts).forEach(([contractName, contract]) => {
                    console.log(`${contractName}: \n  ↖${contract.linearizedDependencies.join("\n  ↖")}`);
                });
            });
        }
    });
}

function cmdStats(argv) {
    argv.files.forEach(f => {
        if (f.endsWith(".sol") && !f.includes("test") && !f.includes("node_modules")) {
            // add files to virtual workspace
            ws.add(f);
        }
    });
    ws.withParserReady().then(() => {
        let allContracts = ws.getAllContracts();

        console.log(`SourceUnits: ${Object.keys(ws.sourceUnits).length}`);
        console.log(`Contracts: ${Object.values(ws.sourceUnits).map(su => Object.keys(su.contracts).length).reduce((a, b) => a + b, 0)}`);
        console.log(`Unique Contract Names (excluding duplicate contract names): ${Object.keys(allContracts).length}`);
    });
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
    .help()
    .alias('h', 'help')
    .version()
    .alias('v', 'version')
    .argv;


process.argv.forEach(f => {
    if (f.endsWith(".sol") && !f.includes("test") && !f.includes("node_modules")) {
        // add files to virtual workspace
        ws.add(f);
    }
});
// output
//console.log(ws); //show complete workspace
ws.withParserReady().then(() => {
    //ws.sourceUnitsCache = {}; //remove the noise

    ws.find(sourceUnit => sourceUnit.contracts["Reserve"]).then(results => {
        //console.error(results[0].contracts.Reserve.functions.null.identifiers);
    });
    ws.find(sourceUnit => sourceUnit.contracts["PeriodicPrizeStrategy"]).then(results => {
        //console.error(results[0].contracts.PeriodicPrizeStrategy.getExternalCalls());
        console.error(results[0].getExternalCalls());
        //console.log(results[0].flatten());
    });

    //console.log(ws.get("/Users/tintin/workspace/solidity/pooltogether-fortools/code/loot-box/contracts/test/ERC777Mintable.sol"))

});
