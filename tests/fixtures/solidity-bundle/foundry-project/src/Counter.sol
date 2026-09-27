// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// import "./Old.sol";
/* import "./Gone.sol"; */
import {ERC20} from "@openzeppelin/contracts/token/ERC20.sol";
import "solmate/tokens/ERC20.sol";

contract Counter {
    string s = "import x";
    string t = "./Str.sol";

    function f() public pure {
        revert("cannot import");
    }
}
