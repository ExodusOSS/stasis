// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "foo/X.sol";
import "@oz/contracts/utils/Math.sol";

contract A {
    function foo() public pure returns (uint256) {
        return X.value() + Math.max(1, 2);
    }
}
