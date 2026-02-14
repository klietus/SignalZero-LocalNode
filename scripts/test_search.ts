
async function run() {
    const res = await fetch(`http://localhost:3001/api/symbols/search?q=familial%20manipulation`, {
        headers: {
            'x-internal-key': process.env.INTERNAL_SERVICE_KEY || ''
        }
    });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
}
run().catch(console.error);
