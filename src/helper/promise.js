'use strict';
/** 
 * @author github.com/tintinweb
 * @author github.com/vquelque
 * @license MIT
 * 
 * */


//this wraps a Promise and rejects if it has not settled after "millis" ms 
const withTimeout = (millis, promise) => {
    var timeoutId;
    const timeout = new Promise((resolve, reject) => {
        timeoutId = setTimeout(
            () => reject(`Promise timed out after ${millis} ms.`),
            millis);
    })
    return new Promise((resolve, reject) => {
        Promise.race([
            promise,
            timeout
        ]).then(
            (value) => {
                clearTimeout(timeoutId)
                resolve(value);
            },
            (reason) => {
                clearTimeout(timeoutId);
                reject(reason);
            });
    });
};

module.exports = {
    withTimeout
}