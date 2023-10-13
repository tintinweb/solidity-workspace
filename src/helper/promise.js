'use strict';
/** 
 * @author github.com/tintinweb
 * @author github.com/vquelque
 * @license MIT
 * 
 * */


//this wraps a Promise and rejects if it has not settled after "millis" ms 
const withTimeout = (millis, promise, cancelSignal) => {
    var timeoutId;
    
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(
            () => reject(`Promise timed out after ${millis} ms.`),
            millis);
    })
    var promiseToRace = [
        promise,
        timeout
    ];
    if(cancelSignal){
        promiseToRace.push(new Promise((_, reject) => {
            cancelSignal.onCancellationRequested( () => {
                reject(new Error('Promise was cancelled.'));
            });
        }))
    }
    return new Promise((resolve, reject) => {
        Promise.race(promiseToRace).then(
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