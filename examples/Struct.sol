// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.7.0;

import "./interface.sol";

struct A {
    uint A_a; 
    bool A_b;  
    address A_c; 
    uint A_d;   
}


contract Contract1 is SInterface {

    struct B {
        bytes32 B_a;  
        uint B_b;
        address B_c; 
        X B_X;     
    }

    function f(A calldata a, B calldata b) pure public returns (X memory){
        X memory xx = X(a.A_a,b.B_b);
        return xx; 
    }
}

contract Contract2 is Contract1 {

    function f_2(X calldata xx, Party memory party) pure public returns (bool){
        return false; 
    }
}