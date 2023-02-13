'use strict';
/** 
 * @author github.com/tintinweb
 * @author github.com/vquelque
 * @license MIT
 * 
 * */


//this wraps a Promise and rejects if it has not settled after "millis" ms 
const withTimeout = (millis, promise) => {
    const timeout = new Promise((resolve, reject) =>
        setTimeout(
            () => reject(`Promise timed out after ${millis} ms.`),
            millis));
    return Promise.race([
        promise,
        timeout
    ]);
};

module.exports = {
    withTimeout
}