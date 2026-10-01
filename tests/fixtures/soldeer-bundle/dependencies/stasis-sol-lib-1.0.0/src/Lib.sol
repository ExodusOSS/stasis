// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Math} from "./math/Math.sol";

library Lib {
    function clampedAdd(uint256 a, uint256 b, uint256 max) internal pure returns (uint256) {
        return Math.min(a + b, max);
    }
}
