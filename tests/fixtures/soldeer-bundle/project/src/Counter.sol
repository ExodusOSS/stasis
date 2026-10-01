// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Lib} from "stasis-sol-lib/src/Lib.sol";

contract Counter {
    uint256 public constant MAX = 10;
    uint256 public number;

    function add(uint256 n) public {
        number = Lib.clampedAdd(number, n, MAX);
    }
}
