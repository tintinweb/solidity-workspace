# solidity-workspace

A simple workspace based interface to the [solidity-parser](https://github.com/solidity-parser/parser) and objectified Abstract Syntax Tree

## TLDR;

This library works like a headless IDE for solidity projects. Instead of manually parsing file-by-file you get meaningful objects you can work with. 

1. create a `ws = new Workspace()`
2. asynchronously add solidity source code files to the workspace `ws.add('/path/to/solidity.sol', {content: optionalFileContent})`
3. in the meantime, the added source units and their dependencies get parsed into. `new SourceUnit()` objects that provide easy access to solidity source unit properties
4. add as many files as you want
5. finally wait for all the tasks to finish `ws.withParserReady().then(() => { /* do things */})` (note: some internal magic requires 2 passes)
6. search for contracts, source units, ....
7. access source-unit, contract, function properties in an object oriented fashion


Check out the [cli.js](./src/cli.js) for an example on how to use this.


## Developer

TBD


## 🏆 References

- https://marketplace.visualstudio.com/items?itemName=tintinweb.solidity-visual-auditor&ssr=false#overview
