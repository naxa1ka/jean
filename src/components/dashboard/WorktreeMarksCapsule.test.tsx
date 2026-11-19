import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WorktreeMarksCapsule } from './WorktreeMarksCapsule'

const mark = (name: string) => ({ name, color: '#3b82f6' })

describe('WorktreeMarksCapsule', () => {
  it('renders nothing for a worktree without marks', () => {
    const { container } = render(
      <WorktreeMarksCapsule worktree={{}} definitions={[]} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('lists the marks of the worktree with +n for the rest', () => {
    render(
      <WorktreeMarksCapsule
        worktree={{ labels: [mark('A'), mark('B'), mark('C')] }}
        definitions={[]}
      />
    )
    expect(screen.getByLabelText('Marks: A, B, C')).toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
  })

  it('falls back to the legacy single label', () => {
    render(
      <WorktreeMarksCapsule
        worktree={{ label: mark('Old') }}
        definitions={[]}
      />
    )
    expect(screen.getByLabelText('Marks: Old')).toBeInTheDocument()
  })
})
