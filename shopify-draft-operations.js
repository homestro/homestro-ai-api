'use strict';

const COLLECTION_ADD_PRODUCTS_MUTATION = 'mutation($id:ID!,$productIds:[ID!]!){collectionAddProducts(id:$id,productIds:$productIds){collection{id}userErrors{field message}}}';
const PRODUCT_OPTION_UPDATE_MUTATION = 'mutation($productId:ID!,$option:OptionUpdateInput!,$optionValuesToUpdate:[OptionValueUpdateInput!]){productOptionUpdate(productId:$productId,option:$option,optionValuesToUpdate:$optionValuesToUpdate,variantStrategy:LEAVE_AS_IS){product{id options{id name optionValues{id name}} variants(first:100){nodes{id selectedOptions{name value}}}}userErrors{field message code}}}';

function collectionAssignmentRequest(collectionId, productId) {
  return { query: COLLECTION_ADD_PRODUCTS_MUTATION, variables: { id: collectionId, productIds: [productId] } };
}

function optionNameUpdateRequest(productId, optionId, name, optionValuesToUpdate = []) {
  return { query: PRODUCT_OPTION_UPDATE_MUTATION, variables: { productId, option: { id: optionId, name }, optionValuesToUpdate } };
}

module.exports = {
  collectionAssignmentRequest,
  optionNameUpdateRequest
};
