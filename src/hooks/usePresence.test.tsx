// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { usePresence } from './usePresence'

describe('usePresence', () => {
  it('renders as present in the same render that opens a previously hidden child', () => {
    const renders: boolean[] = []

    function Probe({ open }: { open: boolean }) {
      const { present } = usePresence(open, () => {}, 180)
      renders.push(present)
      return present ? <div>dialog</div> : null
    }

    const view = render(<Probe open={false} />)
    view.rerender(<Probe open />)

    // The first render after rerender happens before the hook effect can set state.
    expect(renders[1]).toBe(true)
  })
})
