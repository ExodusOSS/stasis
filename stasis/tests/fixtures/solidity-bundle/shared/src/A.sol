// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Shared.sol";

contract A {
    function foo() public pure returns (uint256) {
        return Shared.value();
    }
}
