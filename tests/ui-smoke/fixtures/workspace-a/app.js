let clicks = 0
document.getElementById('counter').addEventListener('click', (event) => {
  event.target.textContent = `Klicks: ${++clicks}`
})
