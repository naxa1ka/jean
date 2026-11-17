import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SessionMarkChips } from './SessionMarkChips'

const mark = (name: string) => ({ name, color: '#3b82f6' })

describe('SessionMarkChips', () => {
  it('renders nothing without marks', () => {
    const { container } = render(<SessionMarkChips labels={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows two dots and +n for the rest, with all names in the label', () => {
    render(
      <SessionMarkChips
        labels={[mark('Review later'), mark('Blocked'), mark('QA'), mark('X')]}
      />
    )
    const chips = screen.getByLabelText('Marks: Review later, Blocked, QA, X')
    expect(chips.querySelectorAll('.rounded-full')).toHaveLength(2)
    expect(screen.getByText('+2')).toBeInTheDocument()
  })

  it('shows no overflow count for two marks', () => {
    render(<SessionMarkChips labels={[mark('A'), mark('B')]} />)
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument()
  })
})
