// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Math} from "stasis-sol-lib/src/math/Math.sol";
import {Counter} from "../src/Counter.sol";

contract CounterTest {
    function test_Add() public {
        Counter counter = new Counter();
        counter.add(Math.min(3, 4));
        require(counter.number() == 3);
    }
}
