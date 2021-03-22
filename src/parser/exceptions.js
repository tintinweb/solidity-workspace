'use strict';
/** 
 * @author github.com/tintinweb
 * @license MIT
 * 
 * */

class ParserError extends Error {}

class CacheHit {
    constructor(sourceUnit){
        this.sourceUnit = sourceUnit;
    }
}

module.exports = {
    ParserError,
    CacheHit
};