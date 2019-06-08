/**
 * Applies the callback to every item of the array
 * @param {Array} array
 * @param {Function} callback
 */
module.exports = (array, callback) => {
  for (let index = 0; index < array.length; index++) {
    callback(array[index], index, array);
  }
};
