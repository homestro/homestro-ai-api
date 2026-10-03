'use strict';

function safeType(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40) || 'unknown';
}

function responseStructure(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  return output.map(item => {
    const contents = Array.isArray(item?.content) ? item.content.map(part => safeType(part?.type)).join(',') : '';
    return safeType(item?.type) + (item?.role ? ':' + safeType(item.role) : '') + '[' + contents + ']';
  }).join('|') || 'none';
}

function extractOpenAiResponseText(response, { httpStatus } = {}) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) return response.output_text.trim();

  const texts = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type !== 'message' || item?.role !== 'assistant' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!['output_text', 'text'].includes(part?.type) || typeof part.text !== 'string' || !part.text.trim()) continue;
      texts.push(part.text.trim());
    }
  }
  if (texts.length) return texts.join('\n');

  throw new Error(
    'OpenAI response contained no usable assistant text ('+
    'httpStatus='+String(httpStatus ?? 'unknown')+
    ',responseStatus='+safeType(response?.status)+
    ',outputStructure='+responseStructure(response)+')'
  );
}

module.exports = { extractOpenAiResponseText, responseStructure };
