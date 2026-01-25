import parquet from 'parquetjs-lite';

async function inspect() {
    try {
        const reader = await parquet.ParquetReader.openFile('/Users/klietus/Downloads/test-00000-of-00001.parquet');
        const cursor = reader.getCursor();
        const firstRecord = await cursor.next();
        console.log("First record keys:", Object.keys(firstRecord));
        console.log("First record sample:", firstRecord);
        await reader.close();
    } catch (e) {
        console.error(e);
    }
}

inspect();
