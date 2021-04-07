'use strict';
/** 
 * @author github.com/tintinweb
 * @license MIT
 * 
 * 
 * */
//taken from https://github.com/ConsenSys/surya/blob/3147a190152caf8da5e3cfc79d4afcda54d3b0aa/src/utils/parserHelpers.js
//thx goncalo and surya!

const BUILTINS = [
  'gasleft', 'require', 'assert', 'revert', 'addmod', 'mulmod', 'keccak256',
  'sha256', 'sha3', 'ripemd160', 'ecrecover',
];

//https://github.com/ethereum/solidity/blob/c5879589af646bee899745c1a21d065537ad0ea5/test/libsolidity/SolidityParser.cpp#L509
const RESERVED_KEYWORDS = [
  "abstract",
  "after",
  "alias",
  "apply",
  "auto",
  "case",
  "catch",
  "copyof",
  "default",
  "define",
  "final",
  "immutable",
  "implements",
  "in",
  "inline",
  "let",
  "macro",
  "match",
  "mutable",
  "null",
  "of",
  "override",
  "partial",
  "promise",
  "reference",
  "relocatable",
  "sealed",
  "sizeof",
  "static",
  "supports",
  "switch",
  "try",
  "typedef",
  "typeof",
  "unchecked"];

function isLowerCase(str) {
  return str === str.toLowerCase();
}

const parserHelpers = {
  getAstNodeName: node => {
    if(!node){
        return "";
    }
    return node.name || node.memberName || (node.typeName && node.typeName.name) || "";
  },
  /** typechecker */
  isRegularFunctionCall: node => {
    const expr = node.expression;
    // @TODO: replace lowercase for better filtering
    return expr.type === 'Identifier' && isLowerCase(expr.name[0]) && !BUILTINS.includes(expr.name);
  },

  isMemberAccess: node => {
    const expr = node.expression;
    return expr.type === 'MemberAccess' && !['push', 'pop'].includes(expr.memberName);
  },

  isMemberAccessOfAddress: node => {
    const expr = node.expression.expression;
    return expr.type === 'FunctionCall'
      && expr.expression.hasOwnProperty('typeName')
      && expr.expression.typeName.name === 'address';
  },

  isIndexAccess: node => {
    return node.type == 'IndexAccess';
  },

  isMemberAccessOfNameValueExpression: node => {
    const expr = node.expression.expression;
    return node.type === 'FunctionCall'
      && node.expression.type === "NameValueExpression"
      && expr.type === 'MemberAccess';
  },

  isMemberAccessOfArrayOrMapping: node => {
    const expr = node.expression.expression;
    return node.type === 'FunctionCall'
      && expr.type === 'IndexAccess';
  },

  isMemberAccessOfGlobalEvmVar: node => {
    const expr = node.expression.expression;

    if (!expr.expression || expr.expression.type !== "Identifier") {
      return false; // not msg.sender, tx.origin
    }

    //get first level element: msg.sender, tx.origin
    let first = expr.expression.name;

    return node.type === 'FunctionCall'
      && expr.type === 'MemberAccess'
      && (
        (expr.memberName === "sender" && first === "msg")
        ||
        (expr.memberName === "origin" && first === "tx")
        ||
        (expr.memberName === "coinbase" && first === "block")
      );
  },

  isMemberAccessOfStruct: node => {
    const expr = node.expression.expression;
    return node.type === 'FunctionCall'
      && expr.type === 'MemberAccess';
  },

  isAContractTypecast: node => {
    const expr = node.expression.expression;
    // @TODO: replace lowercase for better filtering
    return expr.type === 'FunctionCall'
      && expr.expression.hasOwnProperty('name')
      && !isLowerCase(expr.expression.name[0]);
  },

  isUserDefinedDeclaration: node => {
    return node.hasOwnProperty('typeName') && node.typeName.hasOwnProperty('type') && node.typeName.type === 'UserDefinedTypeName';
  },

  isUserDefinedArrayDeclaration: node => {
    return node.hasOwnProperty('typeName')
      && node.typeName.hasOwnProperty('type')
      && node.typeName.type === 'ArrayTypeName'
      && node.typeName.baseTypeName
      && node.typeName.baseTypeName.type === 'UserDefinedTypeName';
  },

  isUserDefinedMappingDeclaration: node => {
    return node.hasOwnProperty('typeName')
      && node.typeName.hasOwnProperty('type')
      && node.typeName.type === 'Mapping'
      && node.typeName.valueType
      && node.typeName.valueType.type === 'UserDefinedTypeName';
  },

  isAddressDeclaration: node => {
    return node.hasOwnProperty('typeName')
      && node.typeName.hasOwnProperty('type')
      && node.typeName.type === 'ElementaryTypeName'
      && node.typeName.name === 'address';
  },
  isAddressArrayDeclaration: node => {
    return node.hasOwnProperty('typeName')
      && node.typeName.hasOwnProperty('type')
      && node.typeName.type === 'ArrayTypeName'
      && node.typeName.baseTypeName
      && node.typeName.baseTypeName.type === 'ElementaryTypeName'
      && node.typeName.baseTypeName.name === 'address';
  },
  isAddressMappingDeclaration: node => {
    return node.hasOwnProperty('typeName')
      && node.typeName.hasOwnProperty('type')
      && node.typeName.type === 'Mapping'
      && node.typeName.valueType
      && node.typeName.valueType.type === 'ElementaryTypeName'
      && node.typeName.valueType.name === 'address';
  },
};

module.exports = {
  parserHelpers,
  BUILTINS,
  RESERVED_KEYWORDS
};