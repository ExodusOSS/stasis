// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "src/A.sol";

contract B {
    function ok() public pure returns (uint256) { return A(address(0)).ok(); }
}
