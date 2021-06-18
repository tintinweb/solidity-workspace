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

```terminal
⇒  solidity-workspace help
solidity-workspace <cmd> [args]

Commands:
  solidity-workspace flatten <files..>      show file contracts structure.
  solidity-workspace dependencies           output a linearized list of smart
  <files..>                                 contract dependencies (linerized
                                            inherited parents)
  solidity-workspace stats <files..>        random parser stats
  solidity-workspace parse <files..>        print parsed objects

Options:
  -h, --help     Show help                                             [boolean]
  -v, --version  Show version number                                   [boolean]
```
 
##### flatten (lexical)

`#> solidity-workspace flatten code/contracts/core/Core.sol --output flat.sol`

##### stats

```terminal
#>  solidity-workspace stats contracts/core/Core.sol                       
→ fromFile(): contracts/core/Core.sol
→ fromSource(): hash=daf3a03e589430ff94e3304fbbfcc1e7ed0134fb
 * parseAst()
  * _resolveIdentifiers()
  * parseImports()
→ fromFile(): node_modules/@openzeppelin/contracts/proxy/Initializable.sol
→ fromSource(): hash=f1177d352b287ab27db3368a956064663fb11fe5
 * parseAst()
  * _resolveIdentifiers()
  * parseImports()
→ fromFile(): node_modules/@openzeppelin/contracts/utils/Address.sol
→ fromSource(): hash=66db1de364ee244b292cf4cc5e63385e8f6b9420
 * parseAst()
  * _resolveIdentifiers()
  * parseImports()
→ fromFile(): contracts/core/Permissions.sol
→ fromSource(): hash=6312be1e663c80ee4ee027b6a30a5bad7d950cb4
 * parseAst()
  * _resolveIdentifiers()
  * parseImports()
→ fromFile(): node_modules/@openzeppelin/contracts/access/AccessControl.sol
→ fromSource(): hash=e19379096fa4c8eaa567842d9c3f62f056fe17e6
 * parseAst()
Struct member external call detection not yet implemented
Struct member external call detection not yet implemented
Struct member external call detection not yet implemented
Struct member external call detection not yet implemented
Struct member external call detection not yet implemented
  * _resolveIdentifiers()
  * parseImports()
→ fromFile(): node_modules/@openzeppelin/contracts/utils/EnumerableSet.sol
→ fromSource(): hash=899a51116900e639e216d778a3fb01d3f3b94b23
 * parseAst()
  * _resolveIdentifiers()
  * parseImports()
→ fromFile(): node_modules/@openzeppelin/contracts/utils/Context.sol
→ fromSource(): hash=02ebe0e93c5d1da25b91ba7f4cfb990a949263f8
 * parseAst()
  * _resolveIdentifiers()
  * parseImports()
→ fromFile(): contracts/core/IPermissions.sol
→ fromSource(): hash=7ddf1c7a5b05af5b19a9b47530c8f5f0138aeba7
 * parseAst()
  * _resolveIdentifiers()
  * parseImports()
→ fromFile(): contracts/core/ICore.sol
→ fromSource(): hash=1bae17efde3a1064ec30a279c6dde3d2cb622de7
 * parseAst()
  * _resolveIdentifiers()
  * parseImports()
→ fromFile(): contracts/token/IFei.sol
→ fromSource(): hash=5cb090b66a4a2cb7cf298d38ff34bd2649a3d6fd
 * parseAst()
  * _resolveIdentifiers()
  * parseImports()
→ fromFile(): node_modules/@openzeppelin/contracts/token/ERC20/IERC20.sol
→ fromSource(): hash=198932076d74067dee7acdde834235339aa9d909
 * parseAst()
  * _resolveIdentifiers()
  * parseImports()
→ fromFile(): contracts/token/Fei.sol
→ fromSource(): hash=a20178cdbec81f2383d13c5df8bf02f9418691d0
 * parseAst()
  * _resolveIdentifiers()
  * parseImports()
→ fromFile(): node_modules/@openzeppelin/contracts/token/ERC20/ERC20Burnable.sol
→ fromSource(): hash=856518dc7da0422e563ea7dc8fae4704c95b2388
 * parseAst()
  * _resolveIdentifiers()
  * parseImports()
→ fromFile(): node_modules/@openzeppelin/contracts/token/ERC20/ERC20.sol
→ fromSource(): hash=afd4175923b146603ba609a9e9e7f0b678aa1853
 * parseAst()
  * _resolveIdentifiers()
  * parseImports()
→ fromFile(): node_modules/@openzeppelin/contracts/math/SafeMath.sol
→ fromSource(): hash=3906485abfad296a4f57098778ae0b75fec61892
 * parseAst()
  * _resolveIdentifiers()
  * parseImports()
→ fromFile(): contracts/token/IIncentive.sol
→ fromSource(): hash=5715475e1610cee51aa86360a8cf38c61abb34c9
 * parseAst()
  * _resolveIdentifiers()
  * parseImports()
→ fromFile(): contracts/refs/CoreRef.sol
→ fromSource(): hash=e38ef7a3f55c505efc34483adf8de4d73278b0ee
 * parseAst()
  * _resolveIdentifiers()
  * parseImports()
→ fromFile(): contracts/refs/ICoreRef.sol
→ fromSource(): hash=903484983c7c9e64a7896d11292c0dcaa14940a8
 * parseAst()
  * _resolveIdentifiers()
  * parseImports()
→ fromFile(): node_modules/@openzeppelin/contracts/utils/Pausable.sol
→ fromSource(): hash=6c67f31034125f74c134dc0903c0f176cecccbd6
 * parseAst()
  * _resolveIdentifiers()
  * parseImports()
→ fromFile(): contracts/dao/Tribe.sol
→ fromSource(): hash=ba037beab397be55e837b36010e6b2cdeefcb732
 * parseAst()
  * _resolveIdentifiers()
  * parseImports()
SourceUnits: 20
Contracts: 20
Unique Contract Names (excluding duplicate contract names): 20
```



## Developer

TBD


## 🏆 References

- https://marketplace.visualstudio.com/items?itemName=tintinweb.solidity-visual-auditor&ssr=false#overview
