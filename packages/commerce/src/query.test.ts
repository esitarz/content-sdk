import { expect } from 'chai';
import { CommerceError } from './errors';
import { serializeListOptions } from './query';

describe('serializeListOptions', () => {
  it('should return an empty string for no options', () => {
    expect(serializeListOptions()).to.equal('');
    expect(serializeListOptions({})).to.equal('');
  });

  it('should drop undefined values and join arrays', () => {
    const query = serializeListOptions({
      search: 'shoe',
      searchOn: ['Name', 'ID'],
      sortBy: ['!Name', 'ID'],
      page: 2,
      pageSize: undefined,
      catalogID: 'cat',
      filters: { 'xp.Brand': 'Acme', ID: ['a', 'b'], Active: true, Price: '>10', Skip: undefined },
    });
    expect(query).to.equal(
      'search=shoe&searchOn=Name%2CID&sortBy=!Name%2CID&page=2&catalogID=cat' +
        '&xp.Brand=Acme&ID=a%7Cb&Active=true&Price=%3E10'
    );
  });

  it('should pass filter keys through verbatim', () => {
    expect(serializeListOptions({ filters: { 'xp.Size.Code': 'M' } })).to.equal('xp.Size.Code=M');
  });

  it('should throw when a filter key collides with a reserved parameter', () => {
    for (const key of ['page', 'PageSize', 'search', 'sortBy', 'catalogID', 'depth']) {
      expect(() => serializeListOptions({ filters: { [key]: 1 } }), key)
        .to.throw(CommerceError)
        .with.property('source', 'sdk');
    }
  });
});
