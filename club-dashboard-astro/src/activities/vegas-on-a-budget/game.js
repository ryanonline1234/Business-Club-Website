/* Vegas on a Budget: the shared game data.
   Loaded by the presenter page (index.html) and the team page (team.html).
   It holds no Over/Under answers; those live in index.html only. */
(function () {
  var V = {
    job: 'Guest services agent at a Strip resort',
    salary: 52000,
    takeHome: 3600,
    months: 6,
    minStars: 11,
    cardApr: 24,
    startChips: 300,
    investReturn: 0.07,

    // Bills everyone pays, whatever they pick.
    fixed: [
      { label: 'Power, water & internet', note: 'Vegas summers mean the AC runs nonstop', cost: 220 },
      { label: 'Health insurance', note: 'Your share of the plan through work', cost: 120 }
    ],

    // In a "need" category the cheapest option is the need and anything above it is a want.
    categories: [
      {
        key: 'housing', label: 'Housing', kind: 'need',
        options: [
          { key: 'strip', label: 'Studio in a Strip high-rise', detail: 'Pool, gym, a view of the Bellagio fountains', cost: 1950, stars: 3 },
          { key: 'summerlin', label: '1-bedroom in Summerlin', detail: 'Quiet, all yours, 25 minutes to work', cost: 1350, stars: 2 },
          { key: 'henderson', label: '2-bedroom in Henderson, with a roommate', detail: 'You split the rent and the dishes', cost: 850, stars: 1 }
        ]
      },
      {
        key: 'transport', label: 'Getting around', kind: 'need',
        options: [
          { key: 'suv', label: 'Brand-new SUV', detail: 'Loan payment, full insurance and gas', cost: 850, stars: 3 },
          { key: 'used', label: 'Used car, paid in cash', detail: 'Insurance, gas and upkeep', cost: 350, stars: 2 },
          { key: 'bus', label: 'Bus pass plus the odd rideshare', detail: 'Vegas is spread out, so trips take longer', cost: 140, stars: 1 }
        ]
      },
      {
        key: 'food', label: 'Food', kind: 'need',
        options: [
          { key: 'delivery', label: 'Delivery and eating out most days', detail: 'Buffets, food halls, late-night tacos', cost: 800, stars: 3 },
          { key: 'mix', label: 'Groceries, plus eating out on weekends', detail: 'Cook most nights, treat yourself sometimes', cost: 450, stars: 2 },
          { key: 'prep', label: 'Meal prep, almost all groceries', detail: 'Sunday cooking, packed lunches', cost: 280, stars: 1 }
        ]
      },
      {
        key: 'phone', label: 'Phone', kind: 'need',
        options: [
          { key: 'newest', label: 'Newest phone on a payment plan', detail: 'Plus an unlimited plan', cost: 150, stars: 3 },
          { key: 'lastyear', label: "Last year's phone", detail: 'Plus an unlimited plan', cost: 85, stars: 2 },
          { key: 'prepaid', label: 'Keep your phone, prepaid plan', detail: 'Plenty of data, no frills', cost: 40, stars: 1 }
        ]
      },
      {
        key: 'fun', label: 'Fun', kind: 'want',
        options: [
          { key: 'vip', label: 'Shows, clubs and pool parties every weekend', detail: 'Bottle service is not cheap', cost: 700, stars: 3 },
          { key: 'monthly', label: 'One big night out a month', detail: 'Plus streaming and the movies', cost: 220, stars: 2 },
          { key: 'free', label: 'Free Vegas', detail: 'Red Rock hikes, Fremont Street, First Friday', cost: 50, stars: 1 }
        ]
      },
      {
        key: 'shopping', label: 'Shopping', kind: 'want',
        options: [
          { key: 'forum', label: 'Designer sprees at the Forum Shops', detail: 'New fits every month', cost: 400, stars: 3 },
          { key: 'outlets', label: 'Outlet trips now and then', detail: 'Deals on things you like', cost: 150, stars: 2 },
          { key: 'basics', label: 'Only what you need', detail: 'Replace things when they wear out', cost: 40, stars: 1 }
        ]
      }
    ],

    // The Wheel of Life. effect(choices) returns { amount, note }; negative amounts cost money.
    // Optional events let the team decide: effect(choices, 'yes' | 'no').
    events: [
      {
        key: 'heat', label: 'Heat wave', text: "It's 116°F for a week and the AC never shuts off.",
        effect: function () { return { amount: -180, note: 'Your power bill spikes' }; }
      },
      {
        key: 'engine', label: 'Check engine light', text: 'Something under the hood is making a noise.',
        effect: function (c) {
          if (c.transport === 'suv') return { amount: 0, note: 'Your new SUV is under warranty. The dealer fixes it free' };
          if (c.transport === 'used') return { amount: -750, note: 'Your used car needs a new alternator' };
          return { amount: -60, note: 'No car to fix, but the bus is late all week so you take rideshares' };
        }
      },
      {
        key: 'overtime', label: 'Convention week', text: 'A giant tech convention takes over the city and you pick up extra shifts.',
        effect: function () { return { amount: 450, note: 'Overtime pay' }; }
      },
      {
        key: 'screen', label: 'Cracked screen', text: 'Your phone slides off a table at the food hall.',
        effect: function (c) {
          if (c.phone === 'newest') return { amount: -350, note: 'Newest phones cost the most to fix' };
          return { amount: -200, note: 'A new screen' };
        }
      },
      {
        key: 'urgentcare', label: 'Urgent care', text: 'You sprain an ankle hiking at Red Rock.',
        effect: function () { return { amount: -300, note: 'Your share of the bill after insurance' }; }
      },
      {
        key: 'refund', label: 'Tax refund', text: 'Too much tax came out of your paychecks, so you get some back.',
        effect: function () { return { amount: 300, note: 'Refund' }; }
      },
      {
        key: 'birthday', label: "Best friend's 21st", text: 'They want a weekend on the Strip: hotel, dinner, a show.',
        optional: { yes: 'Go', no: 'Say no' },
        effect: function (c, pick) {
          if (pick === 'yes') return { amount: -400, note: 'You went to the birthday weekend' };
          return { amount: 0, note: 'You said no and sent a gift card... from your fun money' };
        }
      },
      {
        key: 'slow', label: 'Slow season', text: 'Fewer tourists means fewer shifts this month.',
        effect: function () { return { amount: -600, note: 'A smaller paycheck' }; }
      },
      {
        key: 'roommate', label: 'Roommate moves out', text: 'They leave with two weeks of notice.',
        effect: function (c) {
          if (c.housing === 'henderson') return { amount: -850, note: 'You cover their half of the rent for a month' };
          return { amount: 0, note: "You live alone, so this one isn't your problem" };
        }
      },
      {
        key: 'slots', label: 'The slots are "hot"', text: 'A coworker swears the machines by the break room are about to pay out.',
        optional: { yes: 'Play $200', no: 'Walk away' },
        effect: function (c, pick, roll) {
          if (pick !== 'yes') return { amount: 0, note: 'You walked away. The house gets nothing from you' };
          // Made-up odds, tilted toward the house like a real casino: you get back $72 per $200 on average.
          if (roll < 0.02) return { amount: 800, note: 'Jackpot! You put in $200 and walked out with $1,000' };
          if (roll < 0.10) return { amount: 200, note: 'You put in $200 and walked out with $400' };
          if (roll < 0.30) return { amount: -100, note: 'You put in $200 and walked out with $100' };
          return { amount: -200, note: 'You put in $200 and walked out with nothing' };
        }
      }
    ],

    // Over/Under questions. The lines are here; the answers are on the presenter page.
    questions: [
      { q: "Nevada's state income tax rate", line: '3%' },
      { q: 'Average interest rate (APR) on a credit card that charges interest', line: '15%' },
      { q: 'Cents the casino keeps, on average, from every $1 bet on American roulette', line: '2¢' },
      { q: 'Dollars Las Vegas Strip slot machines keep from every $100 played', line: '$3' },
      { q: 'Average yearly return of the S&P 500 stock index over the long run, before inflation', line: '5%' },
      { q: "Share of U.S. adults who couldn't cover a surprise $400 bill with cash", line: '20%' },
      { q: 'Years to pay off $3,000 on a 24% credit card if you pay $100 a month', line: '2 years' },
      { q: 'What $200 a month, invested from age 22 to 62 at 7% a year, grows to', line: '$250,000' }
    ]
  };

  V.fixedTotal = V.fixed.reduce(function (s, f) { return s + f.cost; }, 0);

  V.option = function (catKey, optKey) {
    var cat = V.categories.filter(function (c) { return c.key === catKey; })[0];
    return cat && cat.options.filter(function (o) { return o.key === optKey; })[0];
  };

  V.event = function (key) {
    return V.events.filter(function (e) { return e.key === key; })[0];
  };

  // Future value of a monthly deposit, compounded monthly.
  V.grow = function (start, monthly, years, rate) {
    var r = (rate == null ? V.investReturn : rate) / 12;
    var n = Math.round(years * 12);
    return start * Math.pow(1 + r, n) + (r ? monthly * (Math.pow(1 + r, n) - 1) / r : monthly * n);
  };

  V.money = function (n) {
    var sign = n < 0 ? '−' : '';
    return sign + '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
  };

  window.VEGAS = V;
})();
