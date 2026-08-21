# Job filtering requirements

Edit this file to change what counts as a match. It is re-read on every scrape,
so you do not need to restart the server — just save and scrape again.

One bullet per requirement, each covering both what to look for and what to
avoid. Everything below this line is sent to Claude as the system prompt.

---

I am a Master of Science in Data Science student at Northeastern University,
graduating December 2026, looking for an early-career role in the United States.
My target is machine learning, deep learning, AI, or software engineering. I
have internship experience (ML engineering, voice/LLM agents, computer vision,
MLOps) but I am effectively a new grad, and I will need visa sponsorship.

Match a job only if EVERY bullet below holds. Judge only from what the posting
actually says — never infer a restriction from silence.

- **Experience** — Match when the lowest number of years the posting asks for is
  2 or fewer: no experience required, experience never mentioned, "new grad",
  "0-2 years", "0-3 years", "1-3 years", "1+ years", "2+ years", "at least 2
  years", or a range whose floor is 2 or below. Internship experience counts,
  so postings that ask for "internship experience" or "some project experience"
  are a match. Reject when the lowest number is 3 or more, however it is
  phrased: "3-5 years", "3+ years", "minimum 3 years", a bare "3 years of
  experience", or anything higher like "4-6 years" and "5+ years". A floor of 3
  or more competes me against people with several years of full-time work; a
  floor of 2 or below (or none) is aimed at my level.

- **Seniority** — Match new-grad and entry-level roles: "New Grad", "University
  Grad", "Entry Level", "Junior", "Associate", "Early Career", a plain
  "Software Engineer", "Machine Learning Engineer", "Data Scientist", or those
  same titles with "I" or "II". Also match paid internships and co-ops, since I
  am still a student. Reject any title containing Senior, Sr., Staff, Principal,
  Lead, Manager, Director or Architect, and reject a posting whose
  responsibilities imply seniority even when the title does not — owning an
  entire platform, setting technical direction for an organisation, or managing
  engineers. Where a posting gives both a title and a number of years, trust the
  number: "Machine Learning Engineer II, 1-3 years" is a match, "Software
  Engineer, 6+ years" is not.

- **Kind of work** — Match roles whose main work is machine learning, deep
  learning, AI, data science, or software engineering: ML engineering, MLOps,
  applied scientist / applied ML, research engineering, computer vision, NLP or
  LLM work, generative AI, recommendation systems, data science and modeling,
  and general software engineering (backend, frontend, full stack, platform, or
  infrastructure). Reject roles whose main work is something else even when they
  sit inside an engineering or data organisation or carry an ML/software-sounding
  title: pure data analytics or BI-reporting-only positions, data-entry, QA or
  test-only roles, IT support and help desk, business or systems analysis,
  technical sales, and recruiting. Data analyst roles that are only dashboards
  and reporting, with no modeling or engineering, are a reject.

- **Location** — Match roles based in the United States, including fully remote
  and hybrid. Reject roles based in another country, and reject remote roles
  restricted to a region I am not in, such as "remote within Canada" or "remote,
  EMEA only". A US city with no remote option is still a match.

- **Visa sponsorship** — I will need sponsorship (F-1 / OPT now, H-1B later), so
  this bullet is strict. Match when the posting says nothing about sponsorship,
  or asks only for general work authorization such as "must be legally
  authorized to work in the United States", or explicitly offers sponsorship.
  Reject when it rules sponsorship out in any form: "we are unable to sponsor or
  take over sponsorship of an employment visa", "no visa sponsorship available",
  "H-1B sponsorship is not offered", "candidates must be authorized to work in
  the US without sponsorship, now or in the future", "the right to work without
  needing visa sponsorship", or "OPT/CPT candidates will not be considered".

- **Citizenship** — Match when citizenship is not mentioned, and match when it
  appears only in equal-opportunity boilerplate — the clause listing citizenship
  alongside race, religion, disability, veteran status and genetic information
  is a promise not to discriminate, so it is never a reason to reject. Reject
  when the role is genuinely restricted by status: "must be a US citizen", "US
  Persons only", "green card holders or citizens only", or an ITAR or export
  control clause limiting the role to citizens and permanent residents — I am
  not a citizen or permanent resident.

- **Security clearance** — I cannot hold a clearance. Match when no clearance is
  mentioned. Reject when an active, existing, or obtainable clearance is
  required or is a condition of employment, including "active Secret", "Top
  Secret/SCI", "must be clearable", and "ability to obtain a clearance".

- **Pay** — Match salaried and hourly paid positions, including paid internships
  and co-ops, whether or not a range is published. Reject unpaid internships,
  volunteer positions, equity-only or commission-only roles, and anything where
  the employment type is listed as Volunteer.
