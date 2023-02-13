'use strict';
/** 
 * @author github.com/vquelque
 * @license MIT
 * 
 * This class implements a cache with an LRU policy
 * */
class LRU {
    constructor(max = 1000) {
        this.max = max;
        this.cache = new Map();
    }

    get(key) {
        let item = this.cache.get(key);
        if (item) {
            // refresh key - O(1)
            this.cache.delete(key);
            this.cache.set(key, item);
        }
        return item;
    }

    set(key, val) {
        // refresh key 
        if (this.cache.has(key)) this.cache.delete(key);
        // evict least recently used
        else if (this.cache.size == this.max) this.cache.delete(this.first());
        this.cache.set(key, val);
    }

    first() {
        return this.cache.keys().next().value;
    }
}

module.exports = {
    LRU
};