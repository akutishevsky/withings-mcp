(function () {
  var badge = document.getElementById("status-badge");
  var dot = document.getElementById("status-dot");
  var text = document.getElementById("status-text");

  fetch("/health", { method: "GET" })
    .then(function (res) {
      if (res.ok) {
        badge.classList.add("operational");
        text.textContent = "Operational";
      } else {
        badge.classList.add("down");
        text.textContent = "Unavailable";
      }
    })
    .catch(function () {
      badge.classList.add("down");
      text.textContent = "Unavailable";
    });
})();
