/**
 * Applies the callback to every item of the array, and resolves once completed
 * @param {Array} array
 * @param {Function} callback
 */
module.exports = async (array, callback) => {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
};
