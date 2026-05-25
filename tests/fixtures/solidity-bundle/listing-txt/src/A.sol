// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@oz/X.sol";

contract A {
    function foo() public pure returns (uint256) {
        return X.value();
    }
}
