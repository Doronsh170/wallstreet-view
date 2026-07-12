# Momentum Desk — Yahoo Prices Worker (v2)

גרסה חדשה של ה-Cloudflare Worker שמאחורי `momentum-yahoo-prices.sh6doron.workers.dev`.

## מה חדש

- **Batch**: בקשה אחת (`?symbols=NVDA,AMD,...`) מחזירה עד 32 מניות בבת אחת — רענון קבוצה שלמה יורד מ-15-25 שניות ל-1-2 שניות. התקרה נבחרה כדי להישאר מתחת למגבלת 50 subrequests לבקשה בתוכנית החינמית של Cloudflare.
- **נתוני מסחר יומי**: לכל מניה מוחזרים גם נפח (`volume`), נפח ממוצע 10 ימים (`avgVol10d` — לחישוב RVOL), פתיחה (`open` — לחישוב גאפ), שיא ושפל יומיים (`dayHigh`/`dayLow`).
- **תאימות לאחור מלאה**: `?symbol=NVDA` ממשיך לעבוד עם אותם שדות כמו קודם, כך שגם גרסה ישנה של האתר תמשיך לתפקד.

## פריסה

1. היכנס ל-Cloudflare Dashboard → Workers & Pages → הworker בשם `momentum-yahoo-prices`.
2. פתח את העורך (Quick Edit / Edit Code).
3. החלף את כל התוכן בקובץ `worker.js` שבתיקייה הזו ושמור (Deploy).

אין צורך בהגדרות נוספות (KV, משתני סביבה וכו') — הקאש של נפח ממוצע משתמש ב-Cache API המובנה.

## בדיקה אחרי פריסה

```
https://momentum-yahoo-prices.sh6doron.workers.dev/?symbol=NVDA
https://momentum-yahoo-prices.sh6doron.workers.dev/?symbols=NVDA,AMD,VRT
```

הראשון צריך להחזיר אובייקט יחיד, השני אובייקט עם `quotes` שמכיל את שלוש המניות.

הערה: האתר (`index.html`) מזהה לבד אם ה-Worker תומך ב-batch. אם עדיין לא פרסת את הגרסה החדשה — האתר ייפול חזרה אוטומטית למשיכה בודדת (כמו היום) וימשיך לעבוד.
