import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SessionMarkChips } from './SessionMarkChips'

const mark = (name: string) => ({ name, color: '#3b82f6' })

describe('SessionMarkChips', () => {
  it('renders nothing without marks', () => {
    const { container } = render(
      <SessionMarkChips labels={[]} definitions={[]} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows two dots and +n for the rest, with all names in the label', () => {
    render(
      <SessionMarkChips
        labels={[mark('Review later'), mark('Blocked'), mark('QA'), mark('X')]}
        definitions={[]}
      />
    )
    const chips = screen.getByLabelText('Marks: Review later, Blocked, QA, X')
    expect(chips.querySelectorAll('.rounded-full')).toHaveLength(2)
    expect(screen.getByText('+2')).toBeInTheDocument()
  })

  it('shows no overflow count for two marks', () => {
    render(
      <SessionMarkChips labels={[mark('A'), mark('B')]} definitions={[]} />
    )
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument()
  })

  it('uses the definition color and icon, matched by name', () => {
    render(
      <SessionMarkChips
        labels={[{ name: 'review LATER', color: '#000000' }, mark('Blocked')]}
        definitions={[
          { name: 'Review later', color: '#3b82f6', icon: '🔖', tracked: true },
          { name: 'Blocked', color: '#ef4444', icon: null, tracked: false },
        ]}
      />
    )
    expect(screen.getByText('🔖')).toBeInTheDocument()
    const dot = screen
      .getByLabelText('Marks: Review later, Blocked')
      .querySelector<HTMLElement>('.rounded-full')
    expect(dot?.style.backgroundColor).toBe('rgb(239, 68, 68)')
  })
})
