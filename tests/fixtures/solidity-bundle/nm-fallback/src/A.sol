// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@oz/contracts/utils/Math.sol";

contract A {
    function foo() public pure returns (uint256) {
        return Math.max(1, 2);
    }
}
