// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Counter} from "../src/Counter.sol";

contract CounterScript {
    function run() public returns (Counter) {
        return new Counter();
    }
}
