import assert from 'node:assert/strict';
import { sanitizeMessagesForToolPairs } from './index.mjs';

// Test 1: clean transcript -> no change
{
  const messages = [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling' },
        { type: 'toolCall', id: 'call_OK|fc_aaa', name: 'exec' },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'call_OK|fc_aaa',
      content: [{ type: 'text', text: 'ok' }],
    },
  ];
  const out = sanitizeMessagesForToolPairs(messages);
  assert.equal(out.sanitized, false, 'clean: no sanitize');
  assert.equal(out.messages.length, 3, 'clean: same length');
}

// Test 2: orphan toolCall without result -> drop only the offending part
{
  const messages = [
    { role: 'user', content: 'do it' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'thinking out loud' },
        { type: 'toolCall', id: 'call_BAD|fc_zzz', name: 'exec' },
      ],
    },
  ];
  const out = sanitizeMessagesForToolPairs(messages);
  assert.equal(out.sanitized, true, 'orphan call: sanitized true');
  assert.deepEqual(out.removedCallIds, ['call_BAD']);
  assert.equal(out.messages.length, 2, 'orphan call: assistant message kept (text remains)');
  const assistant = out.messages[1];
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.content.length, 1);
  assert.equal(assistant.content[0].type, 'text');
}

// Test 3: orphan toolResult without prior toolCall -> drop the result message
{
  const messages = [
    { role: 'user', content: 'first' },
    {
      role: 'toolResult',
      toolCallId: 'call_GHOST',
      content: [{ type: 'text', text: 'ghost' }],
    },
    { role: 'user', content: 'next' },
  ];
  const out = sanitizeMessagesForToolPairs(messages);
  assert.equal(out.sanitized, true, 'orphan result: sanitized true');
  assert.equal(out.removedResultMessages, 1);
  assert.equal(out.messages.length, 2, 'orphan result: result message dropped');
  assert.equal(out.messages[0].role, 'user');
  assert.equal(out.messages[1].role, 'user');
}

// Test 4: composite call_id normalization (call_xxx|fc_yyy vs call_xxx)
{
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'call_NORM|fc_111', name: 'exec' },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'call_NORM',
      content: [{ type: 'text', text: 'ok' }],
    },
  ];
  const out = sanitizeMessagesForToolPairs(messages);
  assert.equal(out.sanitized, false, 'composite-id: matched after normalize');
}

// Test 5: assistant message with ONLY orphan toolCall -> entire message dropped
{
  const messages = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call_LONELY', name: 'exec' }],
    },
  ];
  const out = sanitizeMessagesForToolPairs(messages);
  assert.equal(out.sanitized, true);
  assert.equal(out.messages.length, 1, 'lonely toolCall message dropped');
  assert.equal(out.messages[0].role, 'user');
}

console.log('session-branch-engine tool-pair sanitize test passed');
