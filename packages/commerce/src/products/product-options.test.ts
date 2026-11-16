import { expect } from 'chai';
import { Spec, Variant } from '../ordercloud-types';
import {
  getDefaultSelections,
  getInitialSelections,
  getOptionAvailability,
  hasVariantSpecs,
  resolveVariant,
  toLineItemSpecs,
  validateSelections,
} from './product-options';

const spec = (
  id: string,
  optionIds: string[],
  definesVariant: boolean,
  defaultOptionId?: string
): Spec => ({
  ID: id,
  Name: id,
  Required: definesVariant,
  AllowOpenText: false,
  DefinesVariant: definesVariant,
  DefaultOptionID: defaultOptionId,
  Options: optionIds.map((optionId) => ({ ID: optionId, Value: optionId })),
});

const variant = (id: string, specs: Record<string, string>, active = true): Variant => ({
  ID: id,
  Active: active,
  Specs: Object.entries(specs).map(([SpecID, OptionID]) => ({ SpecID, OptionID })),
});

describe('product options', () => {
  describe('spec selections (ported from the starter)', () => {
    const specs: Spec[] = [
      {
        ID: 'SIZE',
        Name: 'Size',
        Required: true,
        DefinesVariant: true,
        DefaultOptionID: 'MEDIUM',
        Options: [
          { ID: 'SMALL', Value: 'Small' },
          { ID: 'MEDIUM', Value: 'Medium' },
        ],
      },
      {
        ID: 'ENGRAVING',
        Name: 'Engraving',
        Required: false,
        AllowOpenText: true,
        DefaultValue: 'Hello',
        Options: [],
      },
    ];

    it('should initialize product assignment defaults', () => {
      expect(getDefaultSelections(specs)).to.deep.equal({
        SIZE: { optionId: 'MEDIUM' },
        ENGRAVING: { value: 'Hello' },
      });
    });

    it('should validate required options and selected open-text options', () => {
      const openTextOptionSpecs: Spec[] = [
        {
          ...specs[0],
          DefaultOptionID: undefined,
          Options: [{ ID: 'OTHER', Value: 'Other', IsOpenText: true }],
        },
      ];

      expect(validateSelections(specs, {})).to.deep.equal([{ specId: 'SIZE', code: 'required' }]);
      expect(validateSelections(openTextOptionSpecs, { SIZE: { optionId: 'OTHER' } })).to.deep.equal(
        [{ specId: 'SIZE', code: 'value-required' }]
      );
      expect(
        validateSelections(openTextOptionSpecs, { SIZE: { optionId: 'OTHER', value: ' x ' } })
      ).to.deep.equal([]);
    });

    it('should build line-item specs and omit blank optional values', () => {
      expect(
        toLineItemSpecs(specs, { SIZE: { optionId: 'SMALL' }, ENGRAVING: { value: '  Codex  ' } })
      ).to.deep.equal([
        { SpecID: 'SIZE', OptionID: 'SMALL' },
        { SpecID: 'ENGRAVING', Value: 'Codex' },
      ]);
      expect(
        toLineItemSpecs(specs, { SIZE: { optionId: 'SMALL' }, ENGRAVING: { value: '   ' } })
      ).to.have.length(1);
    });

    it('should ignore selections for unknown specs in line-item specs', () => {
      expect(toLineItemSpecs(specs, { OTHER: { optionId: 'x' } })).to.deep.equal([]);
    });
  });

  describe('variants (ported from the starter)', () => {
    const specs = [
      spec('COLOR', ['RED', 'BLUE'], true, 'RED'),
      spec('SIZE', ['S', 'M'], true, 'M'),
      spec('MONOGRAM', ['NONE', 'CUSTOM'], false, 'NONE'),
    ];
    const variants = [
      variant('blue-m', { COLOR: 'BLUE', SIZE: 'M' }),
      variant('red-s', { COLOR: 'RED', SIZE: 'S' }),
      variant('blue-s', { COLOR: 'BLUE', SIZE: 'S' }),
    ];

    it('should not apply variant rules to a product with pure specs', () => {
      const pureSpecs = [spec('LACE-PACK', ['STANDARD', 'TRAIL'], false)];
      expect(hasVariantSpecs(pureSpecs)).to.equal(false);
      expect(getOptionAvailability(pureSpecs, {}, [])).to.deep.equal({});
      expect(resolveVariant(pureSpecs, {}, [])).to.equal(undefined);
    });

    it('should resolve every combination when no variants are disabled', () => {
      const all = [
        variant('red-s', { COLOR: 'RED', SIZE: 'S' }),
        variant('red-m', { COLOR: 'RED', SIZE: 'M' }),
        variant('blue-s', { COLOR: 'BLUE', SIZE: 'S' }),
        variant('blue-m', { COLOR: 'BLUE', SIZE: 'M' }),
      ];
      expect(
        getOptionAvailability(specs, { COLOR: { optionId: 'RED' }, SIZE: { optionId: 'M' } }, all)
      ).to.deep.equal({ COLOR: { RED: true, BLUE: true }, SIZE: { S: true, M: true } });
    });

    it('should disable only options that cannot form an active combination', () => {
      expect(
        getOptionAvailability(specs, { COLOR: { optionId: 'RED' }, SIZE: { optionId: 'S' } }, variants)
      ).to.deep.equal({ COLOR: { RED: true, BLUE: true }, SIZE: { S: true, M: false } });
      expect(
        resolveVariant(specs, { COLOR: { optionId: 'RED' }, SIZE: { optionId: 'M' } }, variants)
      ).to.equal(undefined);
    });

    it('should choose a valid variant when the combined defaults are unavailable', () => {
      expect(getInitialSelections(specs, variants)).to.deep.equal({
        COLOR: { optionId: 'BLUE' },
        SIZE: { optionId: 'M' },
        MONOGRAM: { optionId: 'NONE' },
      });
    });

    it('should keep defaults that resolve to a variant', () => {
      const all = [...variants, variant('red-m', { COLOR: 'RED', SIZE: 'M' })];
      expect(getInitialSelections(specs, all)).to.deep.equal({
        COLOR: { optionId: 'RED' },
        SIZE: { optionId: 'M' },
        MONOGRAM: { optionId: 'NONE' },
      });
    });

    it('should prefer initial selections over defaults and ignore unknown entries', () => {
      expect(
        getInitialSelections(specs, variants, {
          COLOR: { optionId: 'BLUE' },
          SIZE: { optionId: 'S' },
          MONOGRAM: { optionId: 'NOPE' },
          UNKNOWN: { optionId: 'x' },
        })
      ).to.deep.equal({
        COLOR: { optionId: 'BLUE' },
        SIZE: { optionId: 'S' },
        MONOGRAM: { optionId: 'NONE' },
      });
    });

    it('should ignore ordinary specs while resolving a mixed product variant', () => {
      expect(
        resolveVariant(
          specs,
          {
            COLOR: { optionId: 'BLUE' },
            SIZE: { optionId: 'M' },
            MONOGRAM: { optionId: 'CUSTOM', value: 'COD' },
          },
          variants
        )?.ID
      ).to.equal('blue-m');
    });

    it('should ignore inactive variants everywhere', () => {
      const withInactive = [
        variant('red-m', { COLOR: 'RED', SIZE: 'M' }, false),
        variant('red-s', { COLOR: 'RED', SIZE: 'S' }),
      ];
      const selections = { COLOR: { optionId: 'RED' }, SIZE: { optionId: 'M' } };
      expect(resolveVariant(specs, selections, withInactive)).to.equal(undefined);
      expect(getOptionAvailability(specs, selections, withInactive).SIZE).to.deep.equal({
        S: true,
        M: false,
      });
      expect(getInitialSelections(specs, withInactive)).to.deep.include({
        COLOR: { optionId: 'RED' },
        SIZE: { optionId: 'S' },
      });
      expect(validateSelections(specs, selections, withInactive)).to.deep.equal([
        { specId: '', code: 'variant-unavailable' },
      ]);
    });
  });

  describe('getDefaultSelections', () => {
    it('should ignore a default option that is not among the options', () => {
      expect(getDefaultSelections([spec('SIZE', ['S'], false, 'XL')])).to.deep.equal({});
    });

    it('should skip specs without an ID', () => {
      expect(getDefaultSelections([({ Name: 'x', DefaultValue: 'y' } as unknown) as Spec])).to.deep.equal(
        {}
      );
    });
  });

  describe('validateSelections', () => {
    it('should report an invalid option', () => {
      expect(
        validateSelections([spec('SIZE', ['S'], false)], { SIZE: { optionId: 'XL' } })
      ).to.deep.equal([{ specId: 'SIZE', code: 'invalid-option' }]);
    });

    it('should report open text on a spec that does not allow it', () => {
      expect(
        validateSelections([spec('SIZE', ['S'], false)], { SIZE: { optionId: 'S', value: 'big' } })
      ).to.deep.equal([{ specId: 'SIZE', code: 'open-text-not-allowed' }]);
    });

    it('should allow open text when the spec allows it', () => {
      const allowText: Spec = { ...spec('SIZE', ['S'], false), Required: true, AllowOpenText: true };
      expect(validateSelections([allowText], { SIZE: { value: 'custom' } })).to.deep.equal([]);
    });

    it('should report a required text-only spec without value', () => {
      const textOnly: Spec = { ID: 'MSG', Name: 'Message', Required: true, AllowOpenText: true };
      expect(validateSelections([textOnly], { MSG: { value: '  ' } })).to.deep.equal([
        { specId: 'MSG', code: 'value-required' },
      ]);
    });

    it('should report a required spec with no options and no open text as unavailable', () => {
      expect(validateSelections([{ ID: 'X', Name: 'X', Required: true }], {})).to.deep.equal([
        { specId: 'X', code: 'spec-unavailable' },
      ]);
    });

    it('should not report optional specs without selection', () => {
      expect(validateSelections([{ ...spec('SIZE', ['S'], false), Required: false }], {})).to.deep.equal(
        []
      );
    });

    it('should report variant-unavailable only when variants are passed and all variant specs are selected', () => {
      const specs = [spec('COLOR', ['RED', 'BLUE'], true), spec('SIZE', ['S', 'M'], true)];
      const variants = [variant('red-s', { COLOR: 'RED', SIZE: 'S' })];
      const unavailable = { COLOR: { optionId: 'BLUE' }, SIZE: { optionId: 'M' } };

      expect(validateSelections(specs, unavailable)).to.deep.equal([]);
      expect(validateSelections(specs, unavailable, variants)).to.deep.equal([
        { specId: '', code: 'variant-unavailable' },
      ]);
      expect(validateSelections(specs, { COLOR: { optionId: 'BLUE' } }, variants)).to.deep.equal([
        { specId: 'SIZE', code: 'required' },
      ]);
      expect(
        validateSelections(specs, { COLOR: { optionId: 'RED' }, SIZE: { optionId: 'S' } }, variants)
      ).to.deep.equal([]);
    });
  });
});
