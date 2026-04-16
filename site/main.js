// Scroll-triggered fade-in for .feature-card elements
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry, i) => {
      if (entry.isIntersecting) {
        setTimeout(() => {
          entry.target.classList.add('visible')
        }, i * 80)
        observer.unobserve(entry.target)
      }
    })
  },
  { threshold: 0.12 },
)

document.querySelectorAll('.feature-card').forEach((card) => {
  observer.observe(card)
})

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener('click', (e) => {
    const target = document.querySelector(link.getAttribute('href'))
    if (target) {
      e.preventDefault()
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  })
})

// Animated counter for stat values
function animateCounter(el, target, duration = 1400) {
  const start = performance.now()
  const isDecimal = String(target).includes('.')
  const update = (now) => {
    const elapsed = now - start
    const progress = Math.min(elapsed / duration, 1)
    const eased = 1 - Math.pow(1 - progress, 3) // ease-out cubic
    const value = eased * target
    el.textContent = isDecimal
      ? value.toFixed(1) + (el.dataset.suffix || '')
      : Math.floor(value) + (el.dataset.suffix || '')
    if (progress < 1) requestAnimationFrame(update)
  }
  requestAnimationFrame(update)
}

const statObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const el = entry.target
        const target = parseFloat(el.dataset.target)
        animateCounter(el, target)
        statObserver.unobserve(el)
      }
    })
  },
  { threshold: 0.5 },
)

document.querySelectorAll('[data-target]').forEach((el) => {
  statObserver.observe(el)
})
