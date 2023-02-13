// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.7.0;

struct Party {
  address wallet; 
  address token; 
  uint256 id; 
  uint256 amount; 
}

interface SInterface {
    struct X {
        uint X_a;
        uint X_b; 
    }
}