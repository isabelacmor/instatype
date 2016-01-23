function getCard(var card){
	if(cardval == 10){
		return -1;
	}
	if(10 > cardval && cardval >= 7){
		return 0;
	}
	if(7 > cardval && cardval >= 2){
		return +1;
	}
	if(cardval == "A"){
		return 0;		
	}
}