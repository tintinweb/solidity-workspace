'use strict';
/** 
 * @author github.com/tintinweb
 * @license MIT
 * 
 * */
const { resolve } = require('path');
const { readdir } = require('fs').promises;


//https://stackoverflow.com/questions/5827612/node-js-fs-readdir-recursive-directory-search
/*
;(async () => {
    for await (const f of getFiles('.')) {
        console.log(f);
    }
})()
*/

async function* getFiles(dir, filter) {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
        const res = resolve(dir, dirent.name);
        if (dirent.isDirectory()) {
            yield* getFiles(res);
        } else if (!filter || filter(res)) {
            yield res;
        }
    }
}


module.exports = {
    getFiles
};