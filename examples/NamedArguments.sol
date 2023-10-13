// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.0;
contract NamedFunctionParams {
    function f(uint256 baz, string memory foo2) public pure  {}

    function main(uint baz, string memory foo) public pure {
        f({baz: baz, foo2:foo});
    }
}