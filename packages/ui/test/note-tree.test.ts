import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../src/api.ts';
import { nativeType } from '../src/components/NoteTree.tsx';

const n = (type: string, children: TreeNode[] = []): TreeNode => ({
  path: `${type}-${Math.random()}.md`,
  title: type,
  type,
  order: null,
  children,
});

describe('nativeType', () => {
  it('is the type most of a folder has, nested notes included', () => {
    expect(nativeType([n('person', [n('person'), n('person')]), n('person'), n('note')])).toBe(
      'person',
    );
    expect(nativeType([n('org_unit', [n('org_unit', [n('org_unit')])])])).toBe('org_unit');
  });

  it('is nothing when no type has more than half', () => {
    expect(nativeType([n('person'), n('meeting')])).toBeNull();
    expect(nativeType([n('a'), n('a'), n('b'), n('c')])).toBeNull();
    expect(nativeType([])).toBeNull();
  });
});
