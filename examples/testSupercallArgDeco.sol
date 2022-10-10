contract Parent {
    constructor (uint256 arg1_) {}
}

contract Child is Parent {
    constructor (
        uint256 arg1_, 
        uint256 arg2_
    )  
    // does not highlight `arg1_`
    Parent(arg1_) {
        // highlights `arg2_`
        arg2_;
    }
}