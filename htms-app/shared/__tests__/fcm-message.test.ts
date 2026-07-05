import { describe, it, expect } from 'vitest';
import { buildFcmMessage } from '../../netlify/functions/_fcm';

describe('buildFcmMessage', () => {
  it('wraps token + notification in the FCM v1 shape', () => {
    expect(buildFcmMessage('tok123', 'Invoice PRI-1', 'Status updated to "Paid".')).toEqual({
      message: {
        token: 'tok123',
        notification: { title: 'Invoice PRI-1', body: 'Status updated to "Paid".' },
      },
    });
  });
});
