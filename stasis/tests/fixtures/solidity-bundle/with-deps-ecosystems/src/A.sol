// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@solmate/src/Token.sol";
import "@openzeppelin/contracts/utils/Math.sol";

contract A {
    function f() public pure returns (uint256) {
        return Token.decimals() + Math.max(1, 2);
    }
}
