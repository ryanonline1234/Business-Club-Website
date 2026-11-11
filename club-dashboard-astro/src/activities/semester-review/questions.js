/* Semester Review: every clue on the board.
   To make next year's review, edit only this file. Each category is one column and each
   clue one tile. `answer` is the index of the right choice (0 = A, 1 = B, 2 = C, 3 = D).
   `look` picks the column's style: "notebook", "jeopardy", "lab" or "vegas".
   Every fact here comes from the meeting it names; keep it that way so the review only
   asks about what members actually saw. If you change this file, bump the ?v= on the
   <script src="questions.js?v=…"> in index.html so browsers load the new copy. */
(function () {
  window.REVIEW = {
    title: 'Semester Review',
    term: 'Fall 2026',

    categories: [
      {
        key: 'ap',
        name: 'Business 101',
        look: 'notebook',
        from: 'Meeting 1 · Sep 30 · the AP class',
        clues: [
          {
            value: 100,
            q: 'In AP Business with Personal Finance, students design and test a mock business. What is that project called?',
            choices: ['The Business Canvas Project', 'The Shark Tank Project', 'The Startup Portfolio', 'The Market Simulation'],
            answer: 0,
            why: 'It is built on an extended Business Model Canvas, and it is the first free-response question on the AP exam, worth 15% of the score.'
          },
          {
            value: 200,
            q: 'How many multiple-choice questions are on the AP Business with Personal Finance exam?',
            choices: ['40', '60', '75', '100'],
            answer: 1,
            why: '60 questions in 1 hour and 10 minutes, worth 60% of the score.'
          },
          {
            value: 300,
            q: 'Unit 1.2, Markets: how does a market price get set?',
            choices: ['The government sets it', 'Sellers charge whatever they want', 'Buyers and sellers interact until they meet', 'The biggest company decides'],
            answer: 2,
            why: 'Unit 1.2 is about how sellers and buyers interact to establish a market price, and how a business builds a competitive advantage.'
          },
          {
            value: 400,
            q: 'Unit 1.5, Vision: what does a business write to explain its purpose, based on its values and goals?',
            choices: ['A balance sheet', 'A mission statement', 'A slogan', 'A supply chain'],
            answer: 1,
            why: 'Unit 1.5 asks you to develop or evaluate a mission statement. A slogan sells the product; a mission statement says why the business exists.'
          }
        ]
      },
      {
        key: 'firsts',
        name: 'Slogans & Firsts',
        look: 'jeopardy',
        from: 'Meeting 1 · Sep 30 · Jeopardy rematch',
        clues: [
          {
            value: 100,
            q: 'Which company tells you to “Just do it”?',
            choices: ['Adidas', 'Nike', 'Under Armour', 'Puma'],
            answer: 1,
            why: 'Nike, with the slogan it has used since 1988.'
          },
          {
            value: 200,
            q: 'When Amazon launched in 1995, what was the first thing it sold?',
            choices: ['Books', 'CDs', 'Video games', 'Shoes'],
            answer: 0,
            why: 'Amazon started as an online bookstore, then grew into selling almost everything.'
          },
          {
            value: 300,
            q: 'This movie-rental giant went bankrupt in 2010, after passing on the chance to buy Netflix for $50 million.',
            choices: ['Redbox', 'Hulu', 'Blockbuster', 'Best Buy'],
            answer: 2,
            why: 'Blockbuster turned Netflix down in 2000. Ten years later, streaming had taken its customers.'
          },
          {
            value: 400,
            q: 'Before it was called Google, Larry Page and Sergey Brin’s search engine had another name. What was it?',
            choices: ['Googol', 'BackRub', 'PageRank', 'Stanford Search'],
            answer: 1,
            why: 'BackRub, for the backlinks it used to rank pages. A googol (1 followed by 100 zeros) inspired the new name, and PageRank is the ranking method.'
          }
        ]
      },
      {
        key: 'web',
        name: 'Website Lab',
        look: 'lab',
        from: 'Meeting 2 · Oct 14 · Website Report Card',
        clues: [
          {
            value: 100,
            q: 'The 5-second test: look at a homepage for 5 seconds. Which of these is NOT one of its three questions?',
            choices: ['What do they sell?', 'Is it for me, and near me?', 'What do I do next?', 'How old is the company?'],
            answer: 3,
            why: 'The three questions: what do they sell, is it for me and near me, and what do I do next. If you can’t answer all three, customers leave before they scroll.'
          },
          {
            value: 200,
            q: 'Google found that a big share of mobile visits are abandoned when a page takes longer than 3 seconds to load. How big?',
            choices: ['23%', '38%', '53%', '73%'],
            answer: 2,
            why: '53%, from Google’s 2016 study “The Need for Mobile Speed.” Slow sites lose people.'
          },
          {
            value: 300,
            q: 'A website scores 12 out of 16 on the 8‑point report card. What grade is that?',
            choices: ['A', 'B', 'C', 'D'],
            answer: 1,
            why: 'Each of the 8 checks scores 0, 1 or 2. A is 14–16, B is 11–13, C is 8–10, D is 5–7 and F is 0–4.'
          },
          {
            value: 400,
            q: 'Berkshire Hathaway’s website would fail the report card. Why doesn’t that cost the company much?',
            choices: ['Its customers don’t buy on the website', 'It is being redesigned', 'Investors prefer plain websites', 'Only employees can see it'],
            answer: 0,
            why: 'Grade isn’t impact. Its revenue (about $371 billion in 2025) comes from businesses it owns, like GEICO and BNSF Railway, so its website is a filing cabinet, not the store.'
          }
        ]
      },
      {
        key: 'money',
        name: 'Vegas on a Budget',
        look: 'vegas',
        from: 'Meeting 3 · Oct 27 · personal finance',
        clues: [
          {
            value: 100,
            q: 'In the 50/30/20 rule, what does the 20 stand for?',
            choices: ['Needs', 'Wants', 'Savings', 'Taxes'],
            answer: 2,
            why: 'About 50% of take-home pay on needs, 30% on wants, and at least 20% saved.'
          },
          {
            value: 200,
            q: 'What is an emergency fund for?',
            choices: ['A vacation you’re saving for', 'Surprises, like a car repair or a doctor visit', 'Buying stocks when prices drop', 'Paying rent every month'],
            answer: 1,
            why: 'Cash set aside only for surprises. It keeps a bad week off a 24% credit card.'
          },
          {
            value: 300,
            q: 'You owe $3,000 on a 24% credit card and pay $100 a month. About how long until it’s paid off?',
            choices: ['1 year', '2 years', 'Almost 4 years', '10 years'],
            answer: 2,
            why: '47 months. You’d pay about $4,630 in total, so more than $1,600 of it is interest.'
          },
          {
            value: 400,
            q: 'Invest $200 a month from age 22 to 62 at 7% a year. About how much do you end up with?',
            choices: ['$96,000', '$150,000', '$250,000', 'About $525,000'],
            answer: 3,
            why: 'You put in $96,000. Compounding does the rest, and most of the money arrives in the last 15 years.'
          }
        ]
      }
    ],

    // The last question. Teams wager first, then see it. Wrong answers lose the wager.
    final: {
      name: 'The House Edge',
      look: 'vegas',
      from: 'Meeting 3 · Oct 27 · be the house',
      q: 'On average, how many cents of every $1 bet on American roulette does the casino keep?',
      choices: ['0.5¢', '2¢', '5.26¢', '15¢'],
      answer: 2,
      why: 'An American wheel has 38 pockets (1 to 36, 0 and 00), but a win pays as if there were 36. That gap is the house edge, and it is why the house always wins over millions of bets.'
    }
  };
})();
