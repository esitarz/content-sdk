import { expect } from 'chai';
import { CommerceError } from '../errors';
import { createStaticTokenClient } from './static-token-client';

describe('createStaticTokenClient', () => {
  it('returns the fixed shopper token once', async () => {
    const client = createStaticTokenClient(' token ', 'registered');
    const result = await client.getAnonymousToken();

    expect(result).to.deep.include({ persisted: false });
    expect(result.session).to.deep.include({
      accessToken: 'token',
      userType: 'registered',
    });
  });

  it('rejects refresh and second issuance so the identity cannot silently change', async () => {
    const client = createStaticTokenClient('token');
    await client.getAnonymousToken();

    const second = await client.getAnonymousToken().catch((error) => error);
    const refresh = await client.refresh(undefined).catch((error) => error);
    expect(second).to.be.instanceOf(CommerceError);
    expect(refresh).to.be.instanceOf(CommerceError);
    expect(second).to.include({ status: 401, code: 'invalid-token' });
    expect(refresh).to.include({ status: 401, code: 'invalid-token' });
  });

  it('requires a non-empty token', () => {
    expect(() => createStaticTokenClient(' ')).to.throw(CommerceError, 'access token');
  });
});
