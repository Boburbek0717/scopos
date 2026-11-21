// Shared header, sidebar and footer for the Demo University portal, plus the small bits of
// page behaviour (generic pages, the exam table, the confirmation). Fictional data only.
(() => {
  const SECTIONS = [
    ['Home', 'index.html'],
    ['My data', 'page.html?p=My%20data'],
    ['Studies', 'page.html?p=Studies'],
    ['Subjects', 'page.html?p=Subjects'],
    ['Exams', 'exams.html'],
    ['Finances', 'page.html?p=Finances'],
    ['Information', 'page.html?p=Information'],
    ['Administration', 'page.html?p=Administration'],
  ];
  const SERVICES = [
    ['E-learning', 'page.html?p=E-learning'],
    ['Library', 'page.html?p=Library'],
    ['Dormitory', 'page.html?p=Dormitory'],
    ['Student card', 'page.html?p=Student%20card'],
    ['Surveys', 'page.html?p=Surveys'],
  ];
  const here = (location.pathname.split('/').pop() || 'index.html') + location.search;
  const current = document.body.dataset.section || '';

  const link = ([label, href]) => {
    const isCurrent = label === current || href === here;
    return `<a href="${href}"${isCurrent ? ' aria-current="page"' : ''}>${label}</a>`;
  };

  document.body.insertAdjacentHTML('afterbegin', `
    <div class="demo-banner">Fictional demo portal for the Scopos hackathon demo. Not a real university system; all names and data are made up.</div>
    <header class="topbar">
      <a class="brand" href="index.html"><span class="crest" aria-hidden="true">DU</span><span><b>Demo University</b><small>Student Portal</small></span></a>
      <form role="search" onsubmit="event.preventDefault()">
        <input type="search" aria-label="Search the portal" placeholder="Search menus, subjects, documents…">
        <button class="search-btn" type="submit">Search</button>
      </form>
      <div class="top-actions">
        <button type="button">Messages<span class="badge">3</span></button>
        <button type="button">Notifications<span class="badge">5</span></button>
        <button type="button">Help</button>
        <select aria-label="Language"><option>English</option><option>Magyar</option></select>
        <button type="button">Anna Kovács ▾</button>
        <button type="button">Log out</button>
      </div>
    </header>
    <nav class="subbar" aria-label="Term">
      <span>Term: <b>2026/27 autumn</b></span>
      <a href="page.html?p=Change%20term">Change term</a>
      <span>Programme: Computer Science BSc</span>
      <span>Student ID: DEMO123</span>
      <a href="page.html?p=Timetable">Timetable</a>
      <a href="page.html?p=Calendar">Calendar</a>
    </nav>`);

  const layout = document.querySelector('.layout');
  layout.insertAdjacentHTML('afterbegin', `
    <nav class="sidebar" aria-label="Main menu">
      <h2>Menu</h2>${SECTIONS.map(link).join('')}
      <h2>Services</h2>${SERVICES.map(link).join('')}
    </nav>`);

  document.body.insertAdjacentHTML('beforeend', `
    <footer>
      Demo University Student Portal (fictional) ·
      <a href="page.html?p=Accessibility">Accessibility</a>
      <a href="page.html?p=Privacy">Privacy</a>
      <a href="page.html?p=IT%20helpdesk">IT helpdesk</a>
      <a href="page.html?p=User%20guide">User guide (PDF)</a>
    </footer>`);

  // Generic pages: page.html?p=Name shows a believable section with more links.
  const generic = document.getElementById('generic');
  if (generic) {
    const name = new URLSearchParams(location.search).get('p') || 'Page';
    document.title = `${name} · Demo University`;
    document.getElementById('generic-title').textContent = name;
    document.getElementById('generic-crumb').textContent = name;
    const items = {
      'Studies': ['Grade book', 'Timetable', 'Progress report', 'Curriculum', 'Internships'],
      'Subjects': ['Register for subjects', 'Registered subjects', 'Subject catalogue', 'Waiting lists'],
      'Finances': ['Payments', 'Invoices', 'Scholarships', 'Tuition fee', 'Bank details'],
      'Information': ['Messages', 'Notices', 'Calendar', 'Contacts', 'Downloads'],
      'Administration': ['Requests', 'Certificates', 'Student card', 'Change of programme', 'Leave of absence'],
      'My data': ['Personal details', 'Addresses', 'Contact details', 'Documents', 'Settings'],
    }[name] || ['Overview', 'Details', 'History', 'Settings'];
    generic.innerHTML = items.map((i) => `<li><a href="page.html?p=${encodeURIComponent(i)}">${i}</a></li>`).join('');
  }

  // Exam registration table.
  const EXAMS = [
    ['mat101-w', 'MAT101', 'Calculus I', 'Written', 'Fri 12 Dec 2026', '09:00', 'A-101', '14 / 60'],
    ['mat101-o', 'MAT101', 'Calculus I', 'Oral', 'Fri 19 Dec 2026', '10:00', 'B-204', '6 / 20'],
    ['inf102-w', 'INF102', 'Programming 1', 'Written', 'Mon 15 Dec 2026', '13:00', 'Lab 3', '31 / 40'],
    ['mat110-w', 'MAT110', 'Discrete Mathematics', 'Written', 'Wed 17 Dec 2026', '09:00', 'A-102', '22 / 60'],
    ['inf130-w', 'INF130', 'Computer Architecture', 'Written', 'Fri 9 Jan 2027', '08:00', 'C-001', '9 / 80'],
    ['lan120-o', 'LAN120', 'Academic English', 'Oral', 'Mon 12 Jan 2027', '11:00', 'D-310', '3 / 16'],
  ];
  const tbody = document.getElementById('exam-rows');
  if (tbody) {
    tbody.innerHTML = EXAMS.map(([id, code, name, type, date, time, room, seats]) => `
      <tr>
        <td>${code}</td><td>${name}</td><td>${type}</td><td>${date}</td><td>${time}</td><td>${room}</td><td>${seats}</td>
        <td class="actions">
          <a class="btn" href="exam-confirm.html?exam=${id}" aria-label="Register for ${name} ${type.toLowerCase()} exam on ${date}">Register</a>
          <a class="btn secondary" href="page.html?p=${encodeURIComponent(name)}%20details">Details</a>
        </td>
      </tr>`).join('');
  }

  // Confirmation page.
  const confirm = document.getElementById('confirm');
  if (confirm) {
    const id = new URLSearchParams(location.search).get('exam');
    const exam = EXAMS.find((e) => e[0] === id) || EXAMS[0];
    const [, code, name, type, date, time, room] = exam;
    document.getElementById('exam-details').innerHTML = `
      <dt>Subject</dt><dd>${name} (${code})</dd>
      <dt>Exam type</dt><dd>${type}</dd>
      <dt>Date and time</dt><dd>${date}, ${time}</dd>
      <dt>Room</dt><dd>${room}</dd>
      <dt>Registration closes</dt><dd>Sat 6 Dec 2026, 23:59</dd>`;
    const agree = document.getElementById('agree');
    const button = document.getElementById('confirm-btn');
    agree.addEventListener('change', () => { button.disabled = !agree.checked; });
    button.addEventListener('click', () => {
      confirm.hidden = true;
      const done = document.getElementById('done');
      done.hidden = false;
      document.getElementById('done-text').textContent = `You're registered for the ${name} ${type.toLowerCase()} exam on ${date} at ${time}, room ${room}.`;
      done.focus();
    });
  }
})();
