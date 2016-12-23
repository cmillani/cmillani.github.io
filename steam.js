let key = F16C318A2D59910D23C1768549C73324;

function getListForPlayer(id, done) {
	$.get(
		"http://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=" + key + "&steamid=" + id + "&format=json",
		function(data) {
			done(data);
		}
	);	
}

function getNameForGame(id) {

}
