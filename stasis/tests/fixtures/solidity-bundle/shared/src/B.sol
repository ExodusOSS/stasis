// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Shared.sol";

contract B {
    function bar() public pure returns (uint256) {
        return Shared.value() + 1;
    }
}
